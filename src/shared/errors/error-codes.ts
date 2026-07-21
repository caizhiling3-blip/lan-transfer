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
