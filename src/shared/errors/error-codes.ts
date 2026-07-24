import { z } from 'zod'

export const ERROR_CODES = [
  'NETWORK_UNREACHABLE',
  'CONNECTION_REFUSED',
  'CONNECTION_TIMEOUT',
  'CONNECTION_CLOSED',
  'PORT_IN_USE',
  'PROTOCOL_INVALID',
  'MESSAGE_INVALID',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'FILE_COUNT_EXCEEDED',
  'FILE_REJECTED',
  'FILE_NAME_INVALID',
  'FOLDER_NOT_FOUND',
  'FOLDER_SCAN_TIMEOUT',
  'FOLDER_FILE_COUNT_EXCEEDED',
  'FOLDER_TOTAL_SIZE_EXCEEDED',
  'FOLDER_DEPTH_EXCEEDED',
  'FOLDER_PATH_INVALID',
  'FOLDER_PATH_CONFLICT',
  'FOLDER_MANIFEST_TOO_LARGE',
  'FOLDER_SYMLINK_UNSUPPORTED',
  'FOLDER_PUBLISH_FAILED',
  'SAVE_DIRECTORY_INVALID',
  'DISK_SPACE_INSUFFICIENT',
  'TRANSFER_CANCELLED',
  'TRANSFER_TIMEOUT',
  'TRANSFER_FAILED',
] as const

export const errorCodeSchema = z.enum(ERROR_CODES)

export type ErrorCode = z.infer<typeof errorCodeSchema>

export const ERROR_MESSAGES_ZH_CN: Readonly<Record<ErrorCode, string>> = {
  NETWORK_UNREACHABLE: '无法访问目标设备',
  CONNECTION_REFUSED: '目标设备拒绝了连接',
  CONNECTION_TIMEOUT: '设备连接超时',
  CONNECTION_CLOSED: '设备连接已断开',
  PORT_IN_USE: '服务端口已被占用',
  PROTOCOL_INVALID: '通信协议不兼容或无效',
  MESSAGE_INVALID: '收到的消息格式无效',
  FILE_NOT_FOUND: '找不到要发送的文件',
  FILE_TOO_LARGE: '文件超过允许的大小',
  FILE_COUNT_EXCEEDED: '文件数量超过限制',
  FILE_REJECTED: '接收方拒绝了文件',
  FILE_NAME_INVALID: '文件名无效',
  FOLDER_NOT_FOUND: '找不到要发送的文件夹',
  FOLDER_SCAN_TIMEOUT: '文件夹扫描超时',
  FOLDER_FILE_COUNT_EXCEEDED: '文件夹中的文件数量超过限制',
  FOLDER_TOTAL_SIZE_EXCEEDED: '文件夹总大小超过限制',
  FOLDER_DEPTH_EXCEEDED: '文件夹目录层级超过限制',
  FOLDER_PATH_INVALID: '文件夹中包含无法安全传输的路径',
  FOLDER_PATH_CONFLICT: '文件夹中存在跨平台名称冲突',
  FOLDER_MANIFEST_TOO_LARGE: '文件夹清单超过限制',
  FOLDER_SYMLINK_UNSUPPORTED: '文件夹中包含不支持的符号链接',
  FOLDER_PUBLISH_FAILED: '文件夹保存失败',
  SAVE_DIRECTORY_INVALID: '接收目录无效或不可写',
  DISK_SPACE_INSUFFICIENT: '磁盘可用空间不足',
  TRANSFER_CANCELLED: '传输已取消',
  TRANSFER_TIMEOUT: '传输超时',
  TRANSFER_FAILED: '文件传输失败',
}

export interface AppError {
  readonly code: ErrorCode
  readonly message?: string
}
