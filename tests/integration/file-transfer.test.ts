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
    private source: AuthorizedSourceFile | null,
    private readonly receiveDirectory: string,
  ) {}

  public consumeSource(): AuthorizedSourceFile | null {
    const source = this.source
    this.source = null
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

const createConnectedTransferPair = async (
  source: AuthorizedSourceFile,
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
    new TestFileAccess(source, receiveDirectory),
    new SessionHistory(),
  )
  const receiverCoordinator = new FileTransferCoordinator(
    receiver,
    new TestFileAccess(null, receiveDirectory),
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
    await senderCoordinator.offerFile(source.selection.selectionToken)
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
    await senderCoordinator.offerFile(source.selection.selectionToken)
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
    await senderCoordinator.offerFile(source.selection.selectionToken)
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
    await senderCoordinator.offerFile(source.selection.selectionToken)
    const offer = await offerPromise
    await writeFile(sourcePath, 'new content with a different size')
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(senderFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'FILE_NOT_FOUND' })
  })
})
