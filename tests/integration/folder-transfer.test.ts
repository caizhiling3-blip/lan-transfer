import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AuthorizedSourceFolder, FolderAccessAdapter } from '../../src/main/file-transfer'
import { FolderTransferCoordinator, scanFolder } from '../../src/main/file-transfer'
import { LocalServer } from '../../src/main/server/local-server'
import { SessionHistory } from '../../src/main/storage/session-history'
import { ConnectionManager } from '../../src/main/websocket/connection-manager'
import type { FolderOfferReceivedDto } from '@shared/ipc'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo, IncomingConnectionRequestDto, TransferTaskDto } from '@shared/types'

class TestFolderAccess implements FolderAccessAdapter {
  private readonly sources: Map<string, AuthorizedSourceFolder>

  public constructor(
    sources: readonly AuthorizedSourceFolder[],
    private readonly receiveDirectory: string,
  ) {
    this.sources = new Map(sources.map((source) => [source.selection.selectionToken, source]))
  }

  public consumeFolder(selectionToken: string): AuthorizedSourceFolder | null {
    const source = this.sources.get(selectionToken) ?? null
    this.sources.delete(selectionToken)
    return source
  }

  public async resolveReceiveDirectory(): Promise<string> {
    return this.receiveDirectory
  }
}

const temporaryDirectories: string[] = []
const servers: LocalServer[] = []
const managers: ConnectionManager[] = []
const coordinators: FolderTransferCoordinator[] = []

const createDevice = (id: string, name: string, port: number): DeviceInfo => ({
  deviceId: deviceIdSchema.parse(id),
  deviceName: name,
  operatingSystem: 'macos',
  ipAddress: '127.0.0.1',
  servicePort: port,
})

const waitForRequest = (manager: ConnectionManager): Promise<IncomingConnectionRequestDto> =>
  new Promise((resolve) => {
    const unsubscribe = manager.subscribeRequests((request) => {
      unsubscribe()
      resolve(request)
    })
  })

const waitForOffer = (coordinator: FolderTransferCoordinator): Promise<FolderOfferReceivedDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeOffers((offer) => {
      unsubscribe()
      resolve(offer)
    })
  })

const waitForStatus = (
  coordinator: FolderTransferCoordinator,
  status: TransferTaskDto['status'],
): Promise<TransferTaskDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeTasks((task) => {
      if (task.status !== status) return
      unsubscribe()
      resolve(task)
    })
  })

const waitForTerminalStatus = (coordinator: FolderTransferCoordinator): Promise<TransferTaskDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeTasks((task) => {
      if (!['completed', 'failed', 'cancelled', 'rejected'].includes(task.status)) return
      unsubscribe()
      resolve(task)
    })
  })

const createSource = async (
  sourcePath: string,
  selectionToken: string,
): Promise<AuthorizedSourceFolder> => {
  const scanned = await scanFolder(sourcePath)
  return {
    rootPath: scanned.rootPath,
    manifest: scanned.manifest,
    files: scanned.files,
    selection: {
      selectionToken,
      displayName: scanned.manifest.displayName,
      fileCount: scanned.manifest.files.length,
      emptyDirectoryCount: scanned.manifest.emptyDirectories.length,
      totalSize: scanned.manifest.totalSize,
    },
  }
}

const createConnectedPair = async (
  source: AuthorizedSourceFolder,
  receiveDirectory: string,
): Promise<{
  sender: FolderTransferCoordinator
  receiver: FolderTransferCoordinator
  receiverPort: number
  senderHistory: SessionHistory
  receiverHistory: SessionHistory
  senderManager: ConnectionManager
}> => {
  const server = new LocalServer()
  servers.push(server)
  let receiverPort = 0
  const receiverManager = new ConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', receiverPort),
  )
  const senderManager = new ConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(senderManager, receiverManager)
  const senderHistory = new SessionHistory()
  const receiverHistory = new SessionHistory()
  const sender = new FolderTransferCoordinator(
    senderManager,
    new TestFolderAccess([source], receiveDirectory),
    () => true,
    senderHistory,
  )
  const receiver = new FolderTransferCoordinator(
    receiverManager,
    new TestFolderAccess([], receiveDirectory),
    () => true,
    receiverHistory,
  )
  coordinators.push(sender, receiver)
  server.setConnectionHandler((socket, request) => receiverManager.acceptIncoming(socket, request))
  server.setRequestHandler((request, response) => receiver.handleHttpRequest(request, response))
  receiverPort = await server.start(0, '127.0.0.1')

  const requestPromise = waitForRequest(receiverManager)
  const connectionPromise = senderManager.connect('127.0.0.1', receiverPort)
  const request = await requestPromise
  receiverManager.respondToRequest(request.requestId, 'accept')
  await connectionPromise
  return { sender, receiver, receiverPort, senderHistory, receiverHistory, senderManager }
}

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.shutdown()))
  for (const manager of managers.splice(0)) manager.disconnect()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('folder transfer', () => {
  it('transfers more files than the generic HTTP request rate limit', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-many-files-source-'))
    const sourcePath = join(sourceRoot, '大量小文件')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-many-files-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(sourcePath)
    await Promise.all(
      Array.from({ length: 130 }, (_, index) =>
        writeFile(join(sourcePath, `file-${String(index).padStart(3, '0')}.txt`), ''),
      ),
    )
    const source = await createSource(sourcePath, 'q'.repeat(43))
    const { sender, receiver } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderTerminal = waitForTerminalStatus(sender)
    const receiverTerminal = waitForTerminalStatus(receiver)

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')

    await expect(senderTerminal).resolves.toMatchObject({ status: 'completed' })
    await expect(receiverTerminal).resolves.toMatchObject({ status: 'completed' })
    expect((await stat(join(receiveDirectory, '大量小文件', 'file-129.txt'))).isFile()).toBe(true)
  })

  it('publishes nested files without overwriting an existing folder', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-folder-source-'))
    const sourcePath = join(sourceRoot, '项目资料')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-folder-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(join(sourcePath, '文档'), { recursive: true })
    await mkdir(join(sourcePath, '空目录', '子目录'), { recursive: true })
    await writeFile(join(sourcePath, '文档', '说明.txt'), 'folder transfer')
    await writeFile(join(sourcePath, 'zero.bin'), '')
    await mkdir(join(receiveDirectory, '项目资料'))
    await writeFile(join(receiveDirectory, '项目资料', 'existing.txt'), 'existing')
    const source = await createSource(sourcePath, 's'.repeat(43))
    const { sender, receiver, receiverPort, senderHistory, receiverHistory } =
      await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderCompleted = waitForStatus(sender, 'completed')
    const receiverCompleted = waitForStatus(receiver, 'completed')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')

    const senderTask = await senderCompleted
    const receiverTask = await receiverCompleted
    const publishedPath = join(receiveDirectory, '项目资料 (1)')
    await expect(readFile(join(publishedPath, '文档', '说明.txt'), 'utf8')).resolves.toBe(
      'folder transfer',
    )
    await expect(readFile(join(publishedPath, 'zero.bin'))).resolves.toHaveLength(0)
    expect((await stat(join(publishedPath, '空目录', '子目录'))).isDirectory()).toBe(true)
    await expect(
      readFile(join(receiveDirectory, '项目资料', 'existing.txt'), 'utf8'),
    ).resolves.toBe('existing')
    expect(receiver.getReceivedFolderPath(offer.transferId)).toBe(publishedPath)
    expect(senderTask.files.every((file) => file.status === 'completed')).toBe(true)
    expect(receiverTask).toMatchObject({
      status: 'completed',
      transferredBytes: Buffer.byteLength('folder transfer'),
      totalBytes: Buffer.byteLength('folder transfer'),
    })
    expect(senderHistory.list({ offset: 0, limit: 10 })[0]).toMatchObject({
      kind: 'folder',
      status: 'completed',
      displayName: '项目资料',
    })
    expect(receiverHistory.list({ offset: 0, limit: 10 })[0]).toMatchObject({
      kind: 'folder',
      status: 'completed',
      displayName: '项目资料',
    })
    const firstFile = source.manifest.files[0]
    if (firstFile === undefined) throw new Error('Expected a manifest file')
    const replayResponse = await fetch(
      `http://127.0.0.1:${String(receiverPort)}/v2/folder-transfers/${offer.transferId}/files/${firstFile.fileId}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer invalid-replay-token',
          'Content-Length': '0',
          'Content-Type': 'application/octet-stream',
        },
      },
    )
    expect(replayResponse.status).toBe(409)
    expect(sender.getTasks().find((task) => task.transferId === offer.transferId)?.status).toBe(
      'completed',
    )
  })

  it('creates an empty folder tree without opening an upload request', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-empty-source-'))
    const sourcePath = join(sourceRoot, '空项目')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-empty-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(join(sourcePath, '一级', '二级'), { recursive: true })
    const source = await createSource(sourcePath, 'e'.repeat(43))
    const { sender, receiver } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderCompleted = waitForStatus(sender, 'completed')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')

    await expect(senderCompleted).resolves.toMatchObject({
      status: 'completed',
      totalBytes: 0,
    })
    expect((await stat(join(receiveDirectory, '空项目', '一级', '二级'))).isDirectory()).toBe(true)
  })

  it('propagates cancellation without leaving staging content', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-cancel-source-'))
    const sourcePath = join(sourceRoot, '待取消')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-cancel-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'file.txt'), 'content')
    const source = await createSource(sourcePath, 'c'.repeat(43))
    const { sender, receiver } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const receiverCancelled = waitForStatus(receiver, 'cancelled')

    const outgoing = await sender.offerFolder(source.selection.selectionToken)
    await offerPromise
    if (outgoing === null) throw new Error('Expected outgoing task')
    await sender.cancel(outgoing.transferId)

    await expect(receiverCancelled).resolves.toMatchObject({
      status: 'cancelled',
      errorCode: 'TRANSFER_CANCELLED',
    })
    await expect(
      stat(join(receiveDirectory, `.lindu-folder-${outgoing.transferId}.part`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(basename(source.rootPath)).toBe('待取消')
  })

  it('propagates an explicit receiver rejection', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-reject-source-'))
    const sourcePath = join(sourceRoot, '待拒绝')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-reject-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'file.txt'), 'content')
    const source = await createSource(sourcePath, 'r'.repeat(43))
    const { sender, receiver } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderRejected = waitForStatus(sender, 'rejected')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'reject')

    await expect(senderRejected).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'FILE_REJECTED',
    })

    const retryOfferPromise = waitForOffer(receiver)
    const senderCompleted = waitForStatus(sender, 'completed')
    const retried = await sender.retry(offer.transferId)
    const retryOffer = await retryOfferPromise
    if (retried === null) throw new Error('Expected retried task')
    expect(retried.transferId).not.toBe(offer.transferId)
    expect(retried.files[0]?.fileId).not.toBe(source.manifest.files[0]?.fileId)
    await receiver.respondToOffer(retryOffer.transferId, 'accept')
    await expect(senderCompleted).resolves.toMatchObject({ status: 'completed' })
  })

  it('fails both peers and removes staging when a scanned source changes', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-changed-source-'))
    const sourcePath = join(sourceRoot, '已变更')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-changed-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(sourcePath)
    const changedFilePath = join(sourcePath, 'file.txt')
    await writeFile(changedFilePath, 'old')
    const source = await createSource(sourcePath, 'm'.repeat(43))
    const { sender, receiver } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderFailed = waitForStatus(sender, 'failed')
    const receiverFailed = waitForStatus(receiver, 'failed')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await writeFile(changedFilePath, 'new content with another size')
    await receiver.respondToOffer(offer.transferId, 'accept')

    await expect(senderFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
    await expect(
      stat(join(receiveDirectory, `.lindu-folder-${offer.transferId}.part`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans staging when the connection closes during an active upload', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-interrupted-source-'))
    const sourcePath = join(sourceRoot, '中断测试')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-interrupted-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'large.bin'), Buffer.alloc(16 * 1_024 * 1_024, 7))
    const source = await createSource(sourcePath, 'i'.repeat(43))
    const { sender, receiver, senderManager } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const receiverTransferring = waitForStatus(receiver, 'transferring')
    const senderFailed = waitForStatus(sender, 'failed')
    const receiverFailed = waitForStatus(receiver, 'failed')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')
    await receiverTransferring
    senderManager.disconnect()

    await expect(senderFailed).resolves.toMatchObject({ errorCode: 'CONNECTION_CLOSED' })
    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'CONNECTION_CLOSED' })
    await expect(
      stat(join(receiveDirectory, `.lindu-folder-${offer.transferId}.part`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
