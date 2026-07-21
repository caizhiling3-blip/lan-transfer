import type { ErrorCode } from '@shared/errors'
import type {
  FileId,
  FileMetadata,
  FileTransferItemDto,
  TransferId,
  TransferStatus,
  TransferTaskDto,
} from '@shared/types'

const createFileItem = (file: FileMetadata): FileTransferItemDto => ({
  ...file,
  transferredBytes: 0,
  bytesPerSecond: 0,
  status: 'pending',
})

export const createTask = (
  transferId: TransferId,
  direction: 'send' | 'receive',
  peer: TransferTaskDto['peer'],
  files: readonly FileMetadata[],
): TransferTaskDto => {
  const now = Date.now()
  return {
    transferId,
    direction,
    kind: 'file',
    peer,
    status: 'awaitingAcceptance',
    files: files.map(createFileItem),
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    transferredBytes: 0,
    bytesPerSecond: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export const rebuildTask = (
  task: TransferTaskDto,
  files: readonly FileTransferItemDto[],
  status: TransferStatus,
  errorCode?: ErrorCode,
): TransferTaskDto => ({
  ...task,
  status,
  files,
  transferredBytes: files.reduce((total, file) => total + file.transferredBytes, 0),
  bytesPerSecond: files.reduce((total, file) => total + file.bytesPerSecond, 0),
  updatedAt: Date.now(),
  ...(errorCode === undefined ? {} : { errorCode }),
})

export const updateFile = (
  task: TransferTaskDto,
  fileId: FileId,
  status: FileTransferItemDto['status'],
  transferredBytes: number,
  bytesPerSecond: number,
  taskStatus: TransferStatus,
  errorCode?: ErrorCode,
): TransferTaskDto =>
  rebuildTask(
    task,
    task.files.map((file) =>
      file.fileId === fileId
        ? {
            ...file,
            status,
            transferredBytes,
            bytesPerSecond,
            ...(errorCode === undefined ? {} : { errorCode }),
          }
        : file,
    ),
    taskStatus,
    errorCode,
  )

export const updateAllNonTerminalFiles = (
  task: TransferTaskDto,
  fileStatus: FileTransferItemDto['status'],
  taskStatus: TransferStatus,
  errorCode: ErrorCode,
): TransferTaskDto =>
  rebuildTask(
    task,
    task.files.map((file) =>
      ['completed', 'failed', 'cancelled', 'rejected'].includes(file.status)
        ? file
        : { ...file, status: fileStatus, bytesPerSecond: 0, errorCode },
    ),
    taskStatus,
    errorCode,
  )

export const calculateFinishedStatus = (files: readonly FileTransferItemDto[]): TransferStatus => {
  if (files.some((file) => file.status === 'pending' || file.status === 'transferring')) {
    return 'transferring'
  }
  if (files.some((file) => file.status === 'failed')) return 'failed'
  if (files.some((file) => file.status === 'cancelled')) return 'cancelled'
  return files.every((file) => file.status === 'completed') ? 'completed' : 'transferring'
}
