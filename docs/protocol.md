# 通信协议

## 版本与传输

第一版协议版本为 `1`。WebSocket 路径为 `/v1/ws`，负责握手、心跳、文字和文件控制消息；HTTP 负责文件流。文件内容不得转成 Base64 后通过 WebSocket 发送。

`GET /health` 返回 `{ "status": "ok", "protocolVersion": 1 }`，其他未注册 HTTP 路由返回 404。`/v1/ws` 由设备连接管理器接管；已有活动连接时，新 socket 使用 WebSocket close code 1013 关闭。

所有消息使用统一 envelope：

```ts
interface BaseMessage<TType extends string, TPayload> {
  type: TType
  messageId: string
  senderId: string
  timestamp: number
  payload: TPayload
}
```

ID 使用 UUID；timestamp 是非负安全整数毫秒时间戳。对象拒绝未知字段，WebSocket 单条消息最大 128 KiB，文字正文最大 64 KiB（按 UTF-8 字节计算）。

## 设备消息

| type                | payload                                    |
| ------------------- | ------------------------------------------ |
| `device:hello`      | 协议版本、设备信息、连接 nonce             |
| `device:welcome`    | 协议版本、设备信息、connectionId、心跳参数 |
| `device:heartbeat`  | connectionId、递增序号                     |
| `device:disconnect` | connectionId、固定断开原因                 |

设备信息包含设备 UUID、名称、`windows | macos`、IP 和服务端口。陌生设备的 hello 必须先经过本机用户审批。

阶段 6 已实现该状态机。hello/welcome 必须在 10 秒内完成；连接后双方每 10 秒发送 heartbeat，30 秒未收到任何有效消息即断开。入站设备展示 IP 以 TCP socket 来源为准，不信任 hello 中自报的 IP。

## 文字消息

`text:send` 包含非空 `content` 与 `text | link` 类型。链接分类仅用于 UI 展示；打开链接必须由用户主动触发并再次校验 URL scheme。

## 文件消息

| type            | payload                                           |
| --------------- | ------------------------------------------------- |
| `file:offer`    | transferId、1–20 个文件元数据                     |
| `file:accept`   | transferId、逐文件一次性 upload token 与过期时间  |
| `file:reject`   | transferId、固定拒绝原因                          |
| `file:cancel`   | transferId、可选 fileId、固定取消原因             |
| `file:progress` | transferId、fileId、已传字节                      |
| `file:complete` | transferId、fileId、最终大小                      |
| `file:error`    | transferId、可选 fileId、稳定错误码、可选安全详情 |

文件元数据只包含 fileId、展示名、大小和 MIME type，不包含发送方路径或接收方保存路径。0 字节文件合法，单文件最大 2 GiB。MIME type 仅用于展示，不作为安全判断依据。

结构 schema 只验证单条消息。时间偏差、重复 messageId、offer/accept 顺序、进度不超过文件大小、token 状态和来源绑定由后续有状态协调器验证。

## HTTP 上传

接收方接受文件后，发送方逐文件调用：

```text
POST /v1/transfers/:transferId/files/:fileId
Authorization: Bearer <one-time-upload-token>
Content-Type: application/octet-stream
Content-Length: <accepted-file-size>
```

文件名和保存路径不出现在 URL。服务端必须核对 token、来源连接、transferId、fileId、长度和过期时间；落盘流程在阶段 8 实现。

## 错误

协议只使用 `src/shared/errors` 中的稳定错误码。中文文案由接收端本地映射，不作为协议判断依据，也不随网络错误消息传输。
