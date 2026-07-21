import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AuthorizedSourceFile, FileAccessAdapter } from '../../src/main/file-transfer'
import { FileTransferCoordinator } from '../../src/main/file-transfer'
import { LocalServer } from '../../src/main/server/local-server'
import { SessionHistory } from '../../src/main/storage/session-history'
import { ConnectionManager } from '../../src/main/websocket/connection-manager'
import { deviceIdSchema, fileIdSchema } from '@shared/types'
import type {
  DeviceInfo,
  FileOfferReceivedDto,
  IncomingConnectionRequestDto,
  TransferTaskDto,
} from '@shared/index'

class TestFileAccess implements FileAccessAdapter {
  public constructor(
    sources: readonly AuthorizedSourceFile[],
    private readonly receiveDirectory: string,
  ) {
    this.sources = new Map(sources.map((source) => [source.selection.selectionToken, source]))
  }

  private readonly sources: Map<string, AuthorizedSourceFile>

  public consumeSource(selectionToken: string): AuthorizedSourceFile | null {
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
const coordinators: FileTransferCoordinator[] = []

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

const waitForOffer = (coordinator: FileTransferCoordinator): Promise<FileOfferReceivedDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeOffers((offer) => {
      unsubscribe()
      resolve(offer)
    })
  })

const waitForStatus = (
  coordinator: FileTransferCoordinator,
  status: TransferTaskDto['status'],
): Promise<TransferTaskDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeTasks((task) => {
      if (task.status !== status) return
      unsubscribe()
      resolve(task)
    })
  })

const waitForFileStatus = (
  coordinator: FileTransferCoordinator,
  fileId: TransferTaskDto['files'][number]['fileId'],
  status: TransferTaskDto['files'][number]['status'],
): Promise<TransferTaskDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeTasks((task) => {
      if (task.files.find((file) => file.fileId === fileId)?.status !== status) return
      unsubscribe()
      resolve(task)
    })
  })

const createConnectedTransferPair = async (
  source: AuthorizedSourceFile | readonly AuthorizedSourceFile[],
  receiveDirectory: string,
) => {
  const server = new LocalServer()
  servers.push(server)
  let serverPort = 0
  const receiver = new ConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', serverPort),
  )
  const sender = new ConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(sender, receiver)
  const senderCoordinator = new FileTransferCoordinator(
    sender,
    new TestFileAccess(Array.isArray(source) ? source : [source], receiveDirectory),
    new SessionHistory(),
  )
  const receiverCoordinator = new FileTransferCoordinator(
    receiver,
    new TestFileAccess([], receiveDirectory),
    new SessionHistory(),
  )
  coordinators.push(senderCoordinator, receiverCoordinator)
  server.setConnectionHandler((socket, request) => receiver.acceptIncoming(socket, request))
  server.setRequestHandler((request, response) =>
    receiverCoordinator.handleHttpRequest(request, response),
  )
  serverPort = await server.start(0, '127.0.0.1')
  const incomingRequestPromise = waitForRequest(receiver)
  const connectionPromise = sender.connect('127.0.0.1', serverPort)
  const incomingRequest = await incomingRequestPromise
  receiver.respondToRequest(incomingRequest.requestId, 'accept')
  await connectionPromise
  return { senderCoordinator, receiverCoordinator }
}

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.shutdown()))
  for (const manager of managers.splice(0)) manager.disconnect()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('single file transfer', () => {
  it('streams an accepted file and preserves an existing same-name file', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, '测试 file.txt')
    await writeFile(sourcePath, 'new content')
    await writeFile(join(receiveDirectory, '测试 file.txt'), 'existing content')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'a'.repeat(43),
        fileId: fileIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        displayName: '测试 file.txt',
        size: Buffer.byteLength('new content'),
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderCompleted = waitForStatus(senderCoordinator, 'completed')
    const receiverCompleted = waitForStatus(receiverCoordinator, 'completed')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(senderCompleted).resolves.toMatchObject({ status: 'completed' })
    await expect(receiverCompleted).resolves.toMatchObject({ status: 'completed' })
    await expect(readFile(join(receiveDirectory, '测试 file.txt'), 'utf8')).resolves.toBe(
      'existing content',
    )
    await expect(readFile(join(receiveDirectory, '测试 file (1).txt'), 'utf8')).resolves.toBe(
      'new content',
    )
  })

  it('propagates a receiver rejection without uploading', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'reject.txt')
    await writeFile(sourcePath, 'content')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'b'.repeat(43),
        fileId: fileIdSchema.parse('44444444-4444-4444-8444-444444444444'),
        displayName: 'reject.txt',
        size: Buffer.byteLength('content'),
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderRejected = waitForStatus(senderCoordinator, 'rejected')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await receiverCoordinator.respondToOffer(offer.transferId, 'reject')

    await expect(senderRejected).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'FILE_REJECTED',
    })
  })

  it('transfers a zero-byte file', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'empty.txt')
    await writeFile(sourcePath, '')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'c'.repeat(43),
        fileId: fileIdSchema.parse('55555555-5555-4555-8555-555555555555'),
        displayName: 'empty.txt',
        size: 0,
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderCompleted = waitForStatus(senderCoordinator, 'completed')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(senderCompleted).resolves.toMatchObject({ status: 'completed', totalBytes: 0 })
    await expect(readFile(join(receiveDirectory, 'empty.txt'))).resolves.toHaveLength(0)
  })

  it('fails both tasks when the selected source file changes size before upload', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'changed.txt')
    await writeFile(sourcePath, 'old')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'd'.repeat(43),
        fileId: fileIdSchema.parse('66666666-6666-4666-8666-666666666666'),
        displayName: 'changed.txt',
        size: Buffer.byteLength('old'),
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderFailed = waitForStatus(senderCoordinator, 'failed')
    const receiverFailed = waitForStatus(receiverCoordinator, 'failed')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await writeFile(sourcePath, 'new content with a different size')
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(senderFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
  })
})

describe('multiple file transfer', () => {
  it('uploads files serially and aggregates task progress', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const definitions = [
      ['first.txt', 'first', '77777777-7777-4777-8777-777777777777'],
      ['第二个.txt', 'second', '88888888-8888-4888-8888-888888888888'],
      ['third file.txt', 'third', '99999999-9999-4999-8999-999999999999'],
    ] as const
    const sources: AuthorizedSourceFile[] = []
    for (const [name, content, id] of definitions) {
      const path = join(sourceDirectory, name)
      await writeFile(path, content)
      sources.push({
        path,
        selection: {
          selectionToken: id,
          fileId: fileIdSchema.parse(id),
          displayName: name,
          size: Buffer.byteLength(content),
          mimeType: 'text/plain',
        },
      })
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      sources,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderCompleted = waitForStatus(senderCoordinator, 'completed')
    const receiverCompleted = waitForStatus(receiverCoordinator, 'completed')
    await senderCoordinator.offerFiles(sources.map(({ selection }) => selection.selectionToken))
    const offer = await offerPromise
    expect(offer.files).toHaveLength(3)
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    const senderTask = await senderCompleted
    await receiverCompleted
    expect(senderTask.files.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'completed',
    ])
    expect(senderTask.transferredBytes).toBe(senderTask.totalBytes)
    for (const [name, content] of definitions) {
      await expect(readFile(join(receiveDirectory, name), 'utf8')).resolves.toBe(content)
    }
  })

  it('cancels a pending file while allowing completed files to remain', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const firstPath = join(sourceDirectory, 'keep.txt')
    const secondPath = join(sourceDirectory, 'cancel.txt')
    await writeFile(firstPath, Buffer.alloc(2 * 1_024 * 1_024, 1))
    await writeFile(secondPath, 'cancel me')
    const sources: AuthorizedSourceFile[] = [
      {
        path: firstPath,
        selection: {
          selectionToken: 'e'.repeat(43),
          fileId: fileIdSchema.parse('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
          displayName: 'keep.txt',
          size: 2 * 1_024 * 1_024,
          mimeType: 'text/plain',
        },
      },
      {
        path: secondPath,
        selection: {
          selectionToken: 'f'.repeat(43),
          fileId: fileIdSchema.parse('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          displayName: 'cancel.txt',
          size: Buffer.byteLength('cancel me'),
          mimeType: 'text/plain',
        },
      },
    ]
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      sources,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderCancelled = waitForStatus(senderCoordinator, 'cancelled')
    const receiverCancelled = waitForStatus(receiverCoordinator, 'cancelled')
    const offered = await senderCoordinator.offerFiles(
      sources.map(({ selection }) => selection.selectionToken),
    )
    const offer = await offerPromise
    const receiverFileCancelled = waitForFileStatus(
      receiverCoordinator,
      sources[1]!.selection.fileId,
      'cancelled',
    )
    await senderCoordinator.cancel(offer.transferId, sources[1]?.selection.fileId)
    await receiverFileCancelled
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    const senderTask = await senderCancelled
    const receiverTask = await receiverCancelled
    expect(senderTask.files.map(({ status }) => status)).toEqual(['completed', 'cancelled'])
    expect(receiverTask.files.map(({ status }) => status)).toEqual(['completed', 'cancelled'])
    expect(offered?.transferId).toBe(offer.transferId)
    await expect(readFile(join(receiveDirectory, 'keep.txt'))).resolves.toHaveLength(
      2 * 1_024 * 1_024,
    )
    await expect(readFile(join(receiveDirectory, 'cancel.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('retries a rejected task with new transfer and file identifiers', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'retry.txt')
    await writeFile(sourcePath, 'retry content')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'g'.repeat(43),
        fileId: fileIdSchema.parse('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        displayName: 'retry.txt',
        size: Buffer.byteLength('retry content'),
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const firstOfferPromise = waitForOffer(receiverCoordinator)
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const firstOffer = await firstOfferPromise
    const rejectedPromise = waitForStatus(senderCoordinator, 'rejected')
    await receiverCoordinator.respondToOffer(firstOffer.transferId, 'reject')
    await rejectedPromise

    const retryOfferPromise = waitForOffer(receiverCoordinator)
    const retriedTask = await senderCoordinator.retry(firstOffer.transferId)
    const retryOffer = await retryOfferPromise
    expect(retryOffer.transferId).not.toBe(firstOffer.transferId)
    expect(retryOffer.files[0]?.fileId).not.toBe(firstOffer.files[0]?.fileId)
    const completedPromise = waitForStatus(senderCoordinator, 'completed')
    await receiverCoordinator.respondToOffer(retryOffer.transferId, 'accept')

    await expect(completedPromise).resolves.toMatchObject({ transferId: retriedTask?.transferId })
    await expect(readFile(join(receiveDirectory, 'retry.txt'), 'utf8')).resolves.toBe(
      'retry content',
    )
  })

  it('cancels an active whole task and does not publish the file', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'cancel-active.bin')
    await writeFile(sourcePath, Buffer.alloc(4 * 1_024 * 1_024, 7))
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'h'.repeat(43),
        fileId: fileIdSchema.parse('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        displayName: 'cancel-active.bin',
        size: 4 * 1_024 * 1_024,
        mimeType: 'application/octet-stream',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    const started = waitForFileStatus(senderCoordinator, source.selection.fileId, 'transferring')
    const senderCancelled = waitForStatus(senderCoordinator, 'cancelled')
    const receiverCancelled = waitForStatus(receiverCoordinator, 'cancelled')
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')
    await started
    await senderCoordinator.cancel(offer.transferId)

    await expect(senderCancelled).resolves.toMatchObject({ errorCode: 'TRANSFER_CANCELLED' })
    await expect(receiverCancelled).resolves.toMatchObject({ errorCode: 'TRANSFER_CANCELLED' })
    await expect(readFile(join(receiveDirectory, 'cancel-active.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('finishes a one-file offer when that pending file is cancelled', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'cancel-pending.txt')
    await writeFile(sourcePath, 'pending')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'i'.repeat(43),
        fileId: fileIdSchema.parse('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
        displayName: 'cancel-pending.txt',
        size: Buffer.byteLength('pending'),
        mimeType: 'text/plain',
      },
    }
    const { senderCoordinator, receiverCoordinator } = await createConnectedTransferPair(
      source,
      receiveDirectory,
    )
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderCancelled = waitForStatus(senderCoordinator, 'cancelled')
    const receiverCancelled = waitForStatus(receiverCoordinator, 'cancelled')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await senderCoordinator.cancel(offer.transferId, source.selection.fileId)

    await expect(senderCancelled).resolves.toMatchObject({ status: 'cancelled' })
    await expect(receiverCancelled).resolves.toMatchObject({ status: 'cancelled' })
    await expect(receiverCoordinator.respondToOffer(offer.transferId, 'accept')).resolves.toBeNull()
  })
})
