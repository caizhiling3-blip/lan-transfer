import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AuthorizedSourceFolder, FolderAccessAdapter } from '../../src/main/file-transfer'
import { FolderTransferCoordinator, scanFolder } from '../../src/main/file-transfer'
import { LocalServer } from '../../src/main/server/local-server'
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
  const sender = new FolderTransferCoordinator(
    senderManager,
    new TestFolderAccess([source], receiveDirectory),
  )
  const receiver = new FolderTransferCoordinator(
    receiverManager,
    new TestFolderAccess([], receiveDirectory),
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
  return { sender, receiver, receiverPort }
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
  it('streams nested files serially and creates empty directories in staging', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'lindu-folder-source-'))
    const sourcePath = join(sourceRoot, '项目资料')
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lindu-folder-receive-'))
    temporaryDirectories.push(sourceRoot, receiveDirectory)
    await mkdir(join(sourcePath, '文档'), { recursive: true })
    await mkdir(join(sourcePath, '空目录', '子目录'), { recursive: true })
    await writeFile(join(sourcePath, '文档', '说明.txt'), 'folder transfer')
    await writeFile(join(sourcePath, 'zero.bin'), '')
    const source = await createSource(sourcePath, 's'.repeat(43))
    const { sender, receiver, receiverPort } = await createConnectedPair(source, receiveDirectory)
    const offerPromise = waitForOffer(receiver)
    const senderPublishing = waitForStatus(sender, 'publishing')
    const receiverPublishing = waitForStatus(receiver, 'publishing')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')

    const senderTask = await senderPublishing
    const receiverTask = await receiverPublishing
    const stagingRoot = join(receiveDirectory, `.lindu-folder-${offer.transferId}.part`)
    await expect(readFile(join(stagingRoot, '文档', '说明.txt'), 'utf8')).resolves.toBe(
      'folder transfer',
    )
    await expect(readFile(join(stagingRoot, 'zero.bin'))).resolves.toHaveLength(0)
    expect((await stat(join(stagingRoot, '空目录', '子目录'))).isDirectory()).toBe(true)
    expect(senderTask.files.every((file) => file.status === 'completed')).toBe(true)
    expect(receiverTask).toMatchObject({
      status: 'publishing',
      transferredBytes: Buffer.byteLength('folder transfer'),
      totalBytes: Buffer.byteLength('folder transfer'),
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
    const senderPublishing = waitForStatus(sender, 'publishing')

    await sender.offerFolder(source.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'accept')

    await expect(senderPublishing).resolves.toMatchObject({
      status: 'publishing',
      totalBytes: 0,
    })
    const stagingRoot = join(receiveDirectory, `.lindu-folder-${offer.transferId}.part`)
    expect((await stat(join(stagingRoot, '一级', '二级'))).isDirectory()).toBe(true)
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
})
