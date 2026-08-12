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
  'PAIRING_REQUIRED',
  'PAIRING_REJECTED',
  'PAIRING_CODE_INVALID',
  'PAIRING_TIMEOUT',
  'IDENTITY_MISMATCH',
  'SIGNATURE_INVALID',
  'ENCRYPTION_FAILED',
  'DECRYPTION_FAILED',
  'MESSAGE_REPLAYED',
  'FILE_HASH_FAILED',
  'FILE_INTEGRITY_FAILED',
  'CHUNK_INVALID',
  'RESUME_STATE_INVALID',
  'RESUME_EXPIRED',
  'SOURCE_FILE_CHANGED',
  'MOBILE_SESSION_EXPIRED',
  'MOBILE_REQUEST_UNAUTHORIZED',
  'MOBILE_OFFER_CONFLICT',
  'MOBILE_UPLOAD_UNAVAILABLE',
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
  PAIRING_REQUIRED: '需要先完成设备安全配对',
  PAIRING_REJECTED: '设备安全配对已被拒绝',
  PAIRING_CODE_INVALID: '输入的安全配对验证码不正确',
  PAIRING_TIMEOUT: '设备安全配对已超时',
  IDENTITY_MISMATCH: '设备身份与已保存记录不一致',
  SIGNATURE_INVALID: '设备身份签名无效',
  ENCRYPTION_FAILED: '消息加密失败',
  DECRYPTION_FAILED: '消息认证或解密失败',
  MESSAGE_REPLAYED: '检测到重复或过期的加密消息',
  FILE_HASH_FAILED: '无法计算文件完整性摘要',
  FILE_INTEGRITY_FAILED: '文件完整性校验失败',
  CHUNK_INVALID: '文件分块无效或认证失败',
  RESUME_STATE_INVALID: '续传状态无效',
  RESUME_EXPIRED: '可恢复传输已经过期',
  SOURCE_FILE_CHANGED: '源文件在传输后发生变化',
  MOBILE_SESSION_EXPIRED: '手机上传会话已过期',
  MOBILE_REQUEST_UNAUTHORIZED: '手机上传请求未通过验证',
  MOBILE_OFFER_CONFLICT: '已有手机上传请求正在等待处理',
  MOBILE_UPLOAD_UNAVAILABLE: '手机上传服务当前不可用',
}

export type ErrorRecoveryAction = 'reconnect' | 'settings' | 'retry' | 'reselect' | 'none'

export interface ErrorRecoveryAdvice {
  readonly suggestion: string
  readonly action: ErrorRecoveryAction
}

export const ERROR_RECOVERY_ADVICE_ZH_CN: Readonly<Record<ErrorCode, ErrorRecoveryAdvice>> = {
  NETWORK_UNREACHABLE: {
    suggestion: '确认两台设备处于同一局域网，并检查防火墙后重连。',
    action: 'reconnect',
  },
  CONNECTION_REFUSED: {
    suggestion: '确认对方邻渡正在运行、端口正确且允许了传入连接。',
    action: 'reconnect',
  },
  CONNECTION_TIMEOUT: { suggestion: '检查 IP、端口和网络状态后重新连接。', action: 'reconnect' },
  CONNECTION_CLOSED: { suggestion: '重新建立设备连接后再发送。', action: 'reconnect' },
  PORT_IN_USE: { suggestion: '在设置中换用未被占用的服务端口。', action: 'settings' },
  PROTOCOL_INVALID: { suggestion: '确认双方使用兼容版本的邻渡。', action: 'none' },
  MESSAGE_INVALID: { suggestion: '断开异常连接；若持续出现，请导出诊断报告。', action: 'none' },
  FILE_NOT_FOUND: { suggestion: '源文件可能已移动或变化，请重新选择。', action: 'reselect' },
  FILE_TOO_LARGE: {
    suggestion: '选择更小的文件，或检查双方的单文件大小设置。',
    action: 'settings',
  },
  FILE_COUNT_EXCEEDED: { suggestion: '减少本次选择的文件或顶层项目数量。', action: 'reselect' },
  FILE_REJECTED: { suggestion: '接收方拒绝了请求；确认后可从头重新发送。', action: 'retry' },
  FILE_NAME_INVALID: { suggestion: '重命名源文件，避免系统保留名和非法字符。', action: 'reselect' },
  FOLDER_NOT_FOUND: { suggestion: '源文件夹可能已移动或变化，请重新选择。', action: 'reselect' },
  FOLDER_SCAN_TIMEOUT: {
    suggestion: '减少文件夹内容，关闭占用程序后重新选择。',
    action: 'reselect',
  },
  FOLDER_FILE_COUNT_EXCEEDED: {
    suggestion: '拆分文件夹，使每次传输的文件数不超过限制。',
    action: 'reselect',
  },
  FOLDER_TOTAL_SIZE_EXCEEDED: { suggestion: '拆分文件夹并分多次发送。', action: 'reselect' },
  FOLDER_DEPTH_EXCEEDED: { suggestion: '减少目录嵌套层级后重新选择。', action: 'reselect' },
  FOLDER_PATH_INVALID: { suggestion: '移除非法路径或重命名冲突项后重新选择。', action: 'reselect' },
  FOLDER_PATH_CONFLICT: {
    suggestion: '重命名仅大小写不同或跨平台冲突的项目。',
    action: 'reselect',
  },
  FOLDER_MANIFEST_TOO_LARGE: { suggestion: '拆分文件夹，减少单次传输项目。', action: 'reselect' },
  FOLDER_SYMLINK_UNSUPPORTED: {
    suggestion: '移除符号链接，或改为选择实际文件。',
    action: 'reselect',
  },
  FOLDER_PUBLISH_FAILED: { suggestion: '检查接收目录权限和文件占用后从头重试。', action: 'retry' },
  SAVE_DIRECTORY_INVALID: {
    suggestion: '前往设置重新选择有效且可写的接收目录。',
    action: 'settings',
  },
  DISK_SPACE_INSUFFICIENT: {
    suggestion: '释放接收磁盘空间，或选择其他接收目录。',
    action: 'settings',
  },
  TRANSFER_CANCELLED: { suggestion: '如仍需发送，请从头重新传输。', action: 'retry' },
  TRANSFER_TIMEOUT: { suggestion: '检查网络稳定性，重新连接后从头重试。', action: 'retry' },
  TRANSFER_FAILED: { suggestion: '检查双方网络、目录和磁盘状态后从头重试。', action: 'retry' },
  PAIRING_REQUIRED: { suggestion: '请在发起连接的设备上输入对方显示的验证码。', action: 'none' },
  PAIRING_REJECTED: { suggestion: '确认双方设备身份后重新发起配对。', action: 'reconnect' },
  PAIRING_CODE_INVALID: { suggestion: '核对显示验证码的设备后重新输入。', action: 'none' },
  PAIRING_TIMEOUT: {
    suggestion: '重新连接，并在验证码有效期内完成输入验证。',
    action: 'reconnect',
  },
  IDENTITY_MISMATCH: {
    suggestion: '设备密钥可能变化；核对设备后撤销旧信任并重新配对。',
    action: 'none',
  },
  SIGNATURE_INVALID: { suggestion: '连接未通过身份验证，请断开并检查对端版本。', action: 'none' },
  ENCRYPTION_FAILED: { suggestion: '安全会话无法加密消息，请重新连接。', action: 'reconnect' },
  DECRYPTION_FAILED: {
    suggestion: '消息认证失败，连接已不可信，请重新连接。',
    action: 'reconnect',
  },
  MESSAGE_REPLAYED: {
    suggestion: '检测到重放消息，请断开并重新建立安全会话。',
    action: 'reconnect',
  },
  FILE_HASH_FAILED: { suggestion: '确认源文件可读且未被占用，然后重新选择。', action: 'reselect' },
  FILE_INTEGRITY_FAILED: {
    suggestion: '收到的内容校验不一致，请重新建立连接后重试。',
    action: 'retry',
  },
  CHUNK_INVALID: { suggestion: '文件分块认证失败，请重新连接后继续缺失分块。', action: 'retry' },
  RESUME_STATE_INVALID: {
    suggestion: '双方续传记录不一致，请取消旧任务后重新发送。',
    action: 'retry',
  },
  RESUME_EXPIRED: { suggestion: '恢复期限已过，请重新选择内容并发送。', action: 'reselect' },
  SOURCE_FILE_CHANGED: { suggestion: '源文件已经变化，请重新选择后发送。', action: 'reselect' },
  MOBILE_SESSION_EXPIRED: { suggestion: '请在电脑上重新生成二维码。', action: 'none' },
  MOBILE_REQUEST_UNAUTHORIZED: {
    suggestion: '请关闭页面，重新扫描电脑上当前显示的二维码。',
    action: 'none',
  },
  MOBILE_OFFER_CONFLICT: { suggestion: '请先在电脑上处理当前手机上传请求。', action: 'none' },
  MOBILE_UPLOAD_UNAVAILABLE: {
    suggestion: '确认本地服务正在运行，并让手机与电脑连接同一 Wi-Fi。',
    action: 'none',
  },
}

export interface AppError {
  readonly code: ErrorCode
  readonly message?: string
}
