import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AuthorizedSourceFile, FileAccessAdapter } from '../../src/main/file-transfer'
import {
  createChunkDescriptor,
  deriveChunkUploadToken,
} from '../../src/main/file-transfer/chunk-transfer'
import { FileTransferCoordinator } from '../../src/main/file-transfer'
import { LocalServer } from '../../src/main/server/local-server'
import { SessionHistory } from '../../src/main/storage/session-history'
import { RecoverableTransfersStore, type SecretProtector } from '../../src/main/storage'
import type { ConnectionManager } from '../../src/main/websocket/connection-manager'
import { createAutoPairingConnectionManager } from '../helpers/secure-connection'
import { DEFAULT_FILE_CHUNK_SIZE_BYTES } from '@shared/constants'
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

class TestSecretProtector implements SecretProtector {
  public isEncryptionAvailable(): boolean {
    return true
  }

  public encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, 'utf8')
  }

  public decryptString(value: Buffer): string {
    const protectedValue = value.toString('utf8')
    if (!protectedValue.startsWith('protected:')) throw new Error('Invalid ciphertext')
    return protectedValue.slice('protected:'.length)
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
  recoveryStores?: {
    readonly sender: RecoverableTransfersStore
    readonly receiver: RecoverableTransfersStore
  },
) => {
  const server = new LocalServer()
  servers.push(server)
  let serverPort = 0
  const receiver = createAutoPairingConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', serverPort),
  )
  const sender = createAutoPairingConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(sender, receiver)
  const senderCoordinator = new FileTransferCoordinator(
    sender,
    new TestFileAccess(Array.isArray(source) ? source : [source], receiveDirectory),
    new SessionHistory(),
    () => Number.MAX_SAFE_INTEGER,
    () => true,
    recoveryStores?.sender,
  )
  const receiverCoordinator = new FileTransferCoordinator(
    receiver,
    new TestFileAccess([], receiveDirectory),
    new SessionHistory(),
    () => Number.MAX_SAFE_INTEGER,
    () => true,
    recoveryStores?.receiver,
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
  return {
    senderCoordinator,
    receiverCoordinator,
    senderManager: sender,
    receiverManager: receiver,
    receiverPort: serverPort,
    server,
  }
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
    expect(receiverCoordinator.getReceivedFilePath(offer.transferId)).toBe(
      join(await realpath(receiveDirectory), '测试 file (1).txt'),
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

  it('encrypts and transfers a file spanning multiple fixed chunks', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'multi-chunk.bin')
    const content = Buffer.alloc(DEFAULT_FILE_CHUNK_SIZE_BYTES + 257, 0x5a)
    await writeFile(sourcePath, content)
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'k'.repeat(43),
        fileId: fileIdSchema.parse('abababab-abab-4bab-8bab-abababababab'),
        displayName: 'multi-chunk.bin',
        size: content.byteLength,
        mimeType: 'application/octet-stream',
      },
    }
    const { senderCoordinator, receiverCoordinator, senderManager, receiverPort } =
      await createConnectedTransferPair(source, receiveDirectory)
    const uploadTokenPromise = new Promise<string>((resolve) => {
      const unsubscribe = senderManager.subscribeFileMessages((message) => {
        if (message.type !== 'file:accept') return
        const authorization = message.payload.files[0]
        if (authorization === undefined) return
        unsubscribe()
        resolve(authorization.uploadToken)
      })
    })
    const offerPromise = waitForOffer(receiverCoordinator)
    const receiverCompleted = waitForStatus(receiverCoordinator, 'completed')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(receiverCompleted).resolves.toMatchObject({ transferredBytes: content.byteLength })
    await expect(readFile(join(receiveDirectory, 'multi-chunk.bin'))).resolves.toEqual(content)
    const uploadToken = await uploadTokenPromise
    const descriptor = createChunkDescriptor(
      offer.transferId,
      {
        fileId: source.selection.fileId,
        size: content.byteLength,
        chunkSize: DEFAULT_FILE_CHUNK_SIZE_BYTES,
        chunkCount: 2,
      },
      0,
    )
    const duplicateCiphertext = senderManager.encryptFileChunk(
      descriptor,
      content.subarray(0, DEFAULT_FILE_CHUNK_SIZE_BYTES),
    )
    if (duplicateCiphertext === null) throw new Error('Expected an active secure session')
    const duplicateResponse = await fetch(
      `http://127.0.0.1:${String(receiverPort)}/v3/transfers/${offer.transferId}/files/${source.selection.fileId}/chunks/0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${deriveChunkUploadToken(
            uploadToken,
            offer.transferId,
            source.selection.fileId,
            0,
          )}`,
          'Content-Length': String(duplicateCiphertext.byteLength),
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(duplicateCiphertext),
      },
    )
    expect(duplicateResponse.status).toBe(200)
  })

  it('restores a paused task and resumes only the remaining authenticated chunks', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    const senderStoreDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-sender-store-'))
    const receiverStoreDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receiver-store-'))
    temporaryDirectories.push(
      sourceDirectory,
      receiveDirectory,
      senderStoreDirectory,
      receiverStoreDirectory,
    )
    const protector = new TestSecretProtector()
    const senderStore = new RecoverableTransfersStore(senderStoreDirectory, protector)
    const receiverStore = new RecoverableTransfersStore(receiverStoreDirectory, protector)
    const sourcePath = join(sourceDirectory, 'resume.bin')
    const content = Buffer.alloc(DEFAULT_FILE_CHUNK_SIZE_BYTES * 3 + 17, 0x6b)
    await writeFile(sourcePath, content)
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'r'.repeat(43),
        fileId: fileIdSchema.parse('51515151-5151-4151-8151-515151515151'),
        displayName: 'resume.bin',
        size: content.byteLength,
        mimeType: 'application/octet-stream',
      },
    }
    const { senderCoordinator, receiverCoordinator, senderManager, receiverManager, server } =
      await createConnectedTransferPair(source, receiveDirectory, {
        sender: senderStore,
        receiver: receiverStore,
      })
    const offerPromise = waitForOffer(receiverCoordinator)
    const senderPaused = waitForStatus(senderCoordinator, 'paused')
    const receiverPaused = waitForStatus(receiverCoordinator, 'paused')
    let pauseRequested = false
    const unsubscribe = senderCoordinator.subscribeTasks((task) => {
      if (
        pauseRequested ||
        task.status !== 'transferring' ||
        task.transferredBytes < DEFAULT_FILE_CHUNK_SIZE_BYTES
      ) {
        return
      }
      pauseRequested = true
      void senderCoordinator.pause(task.transferId)
    })
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    expect(offer.files[0]).not.toHaveProperty('sha256')
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    const pausedTask = await senderPaused
    await receiverPaused
    unsubscribe()
    expect(pausedTask.transferredBytes).toBeGreaterThanOrEqual(DEFAULT_FILE_CHUNK_SIZE_BYTES)
    expect(pausedTask.transferredBytes).toBeLessThan(content.byteLength)

    await senderCoordinator.shutdown(true)
    await receiverCoordinator.shutdown(true)
    const restoredSender = new FileTransferCoordinator(
      senderManager,
      new TestFileAccess([], receiveDirectory),
      new SessionHistory(),
      () => Number.MAX_SAFE_INTEGER,
      () => true,
      senderStore,
    )
    const restoredReceiver = new FileTransferCoordinator(
      receiverManager,
      new TestFileAccess([], receiveDirectory),
      new SessionHistory(),
      () => Number.MAX_SAFE_INTEGER,
      () => true,
      receiverStore,
    )
    coordinators.push(restoredSender, restoredReceiver)
    server.setRequestHandler((request, response) =>
      restoredReceiver.handleHttpRequest(request, response),
    )
    const senderRecoveryRecords = senderStore.load()
    const receiverRecoveryRecords = receiverStore.load()
    expect(senderRecoveryRecords).toHaveLength(1)
    expect(receiverRecoveryRecords).toHaveLength(1)
    await restoredSender.restoreRecoverableTransfers(senderRecoveryRecords)
    await restoredReceiver.restoreRecoverableTransfers(receiverRecoveryRecords)
    expect(restoredSender.getTasks()).toEqual([
      expect.objectContaining({ transferId: offer.transferId, status: 'recoverable' }),
    ])
    expect(restoredReceiver.getTasks()).toEqual([
      expect.objectContaining({ transferId: offer.transferId, status: 'recoverable' }),
    ])

    const senderCompleted = waitForStatus(restoredSender, 'completed')
    const receiverCompleted = waitForStatus(restoredReceiver, 'completed')
    await restoredSender.resume(offer.transferId)
    await expect(senderCompleted).resolves.toMatchObject({ transferredBytes: content.byteLength })
    await expect(receiverCompleted).resolves.toMatchObject({ transferredBytes: content.byteLength })
    await expect(readFile(join(receiveDirectory, 'resume.bin'))).resolves.toEqual(content)
  }, 20_000)

  it('rejects an authenticated chunk whose ciphertext is modified', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'tampered.bin')
    await writeFile(sourcePath, 'authenticated content')
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      selection: {
        selectionToken: 'l'.repeat(43),
        fileId: fileIdSchema.parse('cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'),
        displayName: 'tampered.bin',
        size: Buffer.byteLength('authenticated content'),
        mimeType: 'application/octet-stream',
      },
    }
    const { senderCoordinator, receiverCoordinator, senderManager } =
      await createConnectedTransferPair(source, receiveDirectory)
    const encryptChunk = senderManager.encryptFileChunk.bind(senderManager)
    let tampered = false
    senderManager.encryptFileChunk = (descriptor, plaintext) => {
      const encrypted = encryptChunk(descriptor, plaintext)
      if (encrypted !== null && !tampered) {
        encrypted[0] = encrypted[0]! ^ 1
        tampered = true
      }
      return encrypted
    }
    const offerPromise = waitForOffer(receiverCoordinator)
    const receiverFailed = waitForStatus(receiverCoordinator, 'failed')
    await senderCoordinator.offerFiles([source.selection.selectionToken])
    const offer = await offerPromise
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'CHUNK_INVALID' })
    await expect(readFile(join(receiveDirectory, 'tampered.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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

  it('rejects content that no longer matches the encrypted offer digest', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-source-'))
    const receiveDirectory = await mkdtemp(join(tmpdir(), 'lan-transfer-receive-'))
    temporaryDirectories.push(sourceDirectory, receiveDirectory)
    const sourcePath = join(sourceDirectory, 'same-size.txt')
    await writeFile(sourcePath, 'old!')
    const metadata = await stat(sourcePath)
    const source: AuthorizedSourceFile = {
      path: sourcePath,
      identity: {
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtimeMs,
      },
      selection: {
        selectionToken: 'j'.repeat(43),
        fileId: fileIdSchema.parse('ffffffff-ffff-4fff-8fff-ffffffffffff'),
        displayName: 'same-size.txt',
        size: 4,
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
    delete (source as { identity?: AuthorizedSourceFile['identity'] }).identity
    await writeFile(sourcePath, 'new!')
    await receiverCoordinator.respondToOffer(offer.transferId, 'accept')

    await expect(senderFailed).resolves.toMatchObject({ status: 'failed' })
    await expect(receiverFailed).resolves.toMatchObject({ errorCode: 'SOURCE_FILE_CHANGED' })
    await expect(readFile(join(receiveDirectory, 'same-size.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
