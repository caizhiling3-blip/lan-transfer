import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { deviceIdSchema, fileIdSchema, transferIdSchema } from '@shared/types'
import type {
  ConnectionStatusDto,
  DeviceInfo,
  HistoryEntryDto,
  TransferTaskDto,
} from '@shared/types'

import type {
  AuthorizedSourceFile,
  AuthorizedSourceFolder,
} from '../../src/main/file-transfer/file-access-registry'
import { TransferQueueCoordinator } from '../../src/main/file-transfer/transfer-queue-coordinator'
import type {
  QueueConnectionAdapter,
  QueuedFileTransferAdapter,
  QueuedFolderTransferAdapter,
  QueueHistoryAdapter,
} from '../../src/main/file-transfer/transfer-queue-coordinator'

const peer: DeviceInfo = {
  deviceId: deviceIdSchema.parse(randomUUID()),
  deviceName: 'Peer',
  operatingSystem: 'macos',
  ipAddress: '192.168.1.20',
  servicePort: 53_317,
}

const createTask = (
  kind: TransferTaskDto['kind'],
  status: TransferTaskDto['status'],
): TransferTaskDto => ({
  transferId: transferIdSchema.parse(randomUUID()),
  direction: 'send',
  kind,
  peer,
  status,
  files: [],
  totalBytes: 0,
  transferredBytes: 0,
  bytesPerSecond: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

class FakeConnection implements QueueConnectionAdapter {
  public statusListener: ((status: ConnectionStatusDto) => void) | null = null
  public readonly sendText = vi.fn(async () => createTask('text', 'completed'))

  public getPeer(): DeviceInfo {
    return peer
  }

  public subscribeStatus(listener: (status: ConnectionStatusDto) => void): () => void {
    this.statusListener = listener
    return () => {
      this.statusListener = null
    }
  }
}

class FakeFileCoordinator implements QueuedFileTransferAdapter {
  public listener: ((task: TransferTaskDto) => void) | null = null
  public active = false
  public readonly offerAuthorizedFiles = vi.fn(async () => {
    this.active = true
    return createTask('file', 'awaitingAcceptance')
  })

  public hasActiveTransfers(): boolean {
    return this.active
  }

  public subscribeTasks(listener: (task: TransferTaskDto) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
}

class FakeFolderCoordinator implements QueuedFolderTransferAdapter {
  public listener: ((task: TransferTaskDto) => void) | null = null
  public active = false
  public readonly offerAuthorizedFolder = vi.fn(async () => {
    this.active = true
    return createTask('folder', 'awaitingAcceptance')
  })

  public hasActiveTransfers(): boolean {
    return this.active
  }

  public subscribeTasks(listener: (task: TransferTaskDto) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
}

const sourceFile: AuthorizedSourceFile = {
  path: '/private/source.txt',
  selection: {
    selectionToken: 'a'.repeat(32),
    fileId: fileIdSchema.parse(randomUUID()),
    displayName: 'source.txt',
    size: 6,
    mimeType: 'text/plain',
  },
}

const sourceFolder: AuthorizedSourceFolder = {
  rootPath: '/private/folder',
  selection: {
    selectionToken: 'b'.repeat(32),
    displayName: 'folder',
    fileCount: 0,
    emptyDirectoryCount: 1,
    totalSize: 0,
  },
  manifest: {
    displayName: 'folder',
    files: [],
    emptyDirectories: ['empty'],
    totalSize: 0,
  },
  files: [],
}

const createHistory = (): QueueHistoryAdapter => ({
  add: (entry): HistoryEntryDto => ({ ...entry, id: randomUUID() }),
})

describe('TransferQueueCoordinator', () => {
  it('serializes text, file, and folder work while retaining claimed selections', async () => {
    const connection = new FakeConnection()
    const files = new FakeFileCoordinator()
    const folders = new FakeFolderCoordinator()
    const access = {
      consumeTransferSelections: vi.fn(() => ({
        files: [sourceFile],
        folders: [sourceFolder],
      })),
    }
    const queue = new TransferQueueCoordinator(connection, access, files, folders, createHistory())

    const result = queue.enqueue({
      text: { content: 'hello', contentType: 'text' },
      fileSelectionTokens: [sourceFile.selection.selectionToken],
      folderSelectionTokens: [sourceFolder.selection.selectionToken],
    })

    expect(result.ok).toBe(true)
    expect(queue.getItems().map(({ kind }) => kind)).toEqual(['text', 'file', 'folder'])
    await vi.waitFor(() => expect(files.offerAuthorizedFiles).toHaveBeenCalledOnce())
    expect(folders.offerAuthorizedFolder).not.toHaveBeenCalled()
    const fileTask = await files.offerAuthorizedFiles.mock.results[0]!.value
    files.active = false
    files.listener?.({ ...fileTask, status: 'completed' })
    await vi.waitFor(() => expect(folders.offerAuthorizedFolder).toHaveBeenCalledOnce())
    const folderTask = await folders.offerAuthorizedFolder.mock.results[0]!.value
    folders.active = false
    folders.listener?.({ ...folderTask, status: 'completed' })
    await vi.waitFor(() => expect(queue.getItems()).toHaveLength(0))
  })

  it('drops waiting work on disconnect and never starts it for a later peer', async () => {
    const connection = new FakeConnection()
    const files = new FakeFileCoordinator()
    files.active = true
    const folders = new FakeFolderCoordinator()
    const queue = new TransferQueueCoordinator(
      connection,
      {
        consumeTransferSelections: () => ({ files: [sourceFile], folders: [] }),
      },
      files,
      folders,
      createHistory(),
    )
    queue.enqueue({
      fileSelectionTokens: [sourceFile.selection.selectionToken],
      folderSelectionTokens: [],
    })
    await vi.waitFor(() => expect(queue.getItems()).toHaveLength(1))

    connection.statusListener?.({ state: 'disconnected' })

    expect(queue.getItems()).toHaveLength(0)
    expect(files.offerAuthorizedFiles).not.toHaveBeenCalled()
  })
})
