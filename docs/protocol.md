# 通信协议

> 当前运行时仍使用协议 v2。v0.4.0 阶段 1 已加入独立的协议 v3 shared 契约，但在身份、配对和安全会话实现完成前不会切换 `PROTOCOL_VERSION`，避免把未加密连接误标为安全连接。

## 协议 v3 shared 契约

v3 握手使用 `secure:hello`、`secure:challenge` 和 `secure:proof`，严格携带 Ed25519 身份公钥、X25519 临时公钥、32 字节 nonce、协议版本和 transcript 签名。握手后的 WebSocket 帧使用 `EncryptedEnvelope`，只包含版本、connectionId、单调 sequence、Base64 密文和 16 字节 AES-GCM tag。

shared 已定义配对决定、带 SHA-256/固定块大小/块数的文件 offer、暂停、续传查询、接收端 verified range 状态，以及 HTTP 加密块描述。schema 只做无状态结构和边界校验；公钥 DER 解析、指纹对应关系、签名、sequence、块数与大小一致性、range 排序/不重叠和任务状态顺序由后续主进程安全状态机验证。

阶段 3 已实现 X25519 共享秘密和 transcript confirmation key 派生、六位验证码以及双端确认状态机。验证码由 confirmation key 通过带固定上下文的 HMAC-SHA-256 派生，只用于用户核对，不作为会话密钥。配对 IPC 使用不透明 requestId，renderer 只能接受或拒绝当前请求；只有主进程收到双方对同一请求的接受后才写可信记录。网络上的 `secure:*` 握手和加密 `pairing:decision` 将在阶段 4 一起启用，当前 v2 帧不会携带验证码或伪装成安全配对。

协议 v2 与 v3 使用独立 parser。v3 正式启用后不得把失败的 v3 握手回退为 v2；旧版本只获得明确的 `PROTOCOL_INVALID`，不会进入业务消息阶段。

## 版本与传输

当前握手协议版本为 `2`。文件夹能力改变了 strict 消息联合，因此 v1 与 v2 明确不兼容，不维护双协议栈。WebSocket 路径仍为 `/v1/ws`，路径只表示现有传输入口；hello 中的 protocolVersion 才决定消息能力。HTTP 负责文件流，文件内容不得转成 Base64 后通过 WebSocket 发送。

`GET /health` 返回 `{ "status": "ok", "protocolVersion": 2 }`，其他未注册 HTTP 路由返回 404。`/v1/ws` 由设备连接管理器接管；已有活动连接时，新 socket 使用 WebSocket close code 1013 关闭。

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

ID 使用 UUID；timestamp 是非负安全整数毫秒时间戳，并且只能处于接收端当前时间前后 5 分钟。对象拒绝未知字段，WebSocket 只接受文本 JSON 控制消息，单条消息最大 128 KiB，文字正文最大 64 KiB（按 UTF-8 字节计算）。连接内消息和新建 WebSocket Upgrade 均有限速。

## UDP 设备发现

1.1 增加独立于 WebSocket 的 UDP4 发现。应用每 5 秒通过每个有效非回环 IPv4 网卡向 `239.255.53.17:53318` 发送组播，并向该网卡所在子网的定向广播地址发送同一份最大 8 KiB JSON 数据报；组播 TTL 为 1，不跨越路由器：

```ts
interface DiscoveryAnnouncement {
  appId: 'lan-drop'
  protocolVersion: 2
  messageId: string
  deviceId: string
  deviceName: string
  operatingSystem: 'windows' | 'macos'
  servicePort: number
  timestamp: number
}
```

对象严格拒绝未知字段，ID、端口、名称和时间戳使用 shared schema 校验。发现包不携带 IP，接收端使用数据报来源 IPv4；自身消息、时间偏差超限和非法 JSON 被静默忽略。设备 16 秒未刷新即从列表移除。发现只提供连接地址，后续仍使用 `/v1/ws` 完成审批握手，不能凭发现包建立信任或授权上传。

## 设备消息

| type                | payload                                                |
| ------------------- | ------------------------------------------------------ |
| `device:hello`      | 协议版本、设备信息、连接 nonce                         |
| `device:welcome`    | 协议版本、设备信息、回显 nonce、connectionId、心跳参数 |
| `device:heartbeat`  | connectionId、递增序号                                 |
| `device:disconnect` | connectionId、固定断开原因                             |

设备信息包含设备 UUID、名称、`windows | macos`、IP 和服务端口。陌生设备的 hello 必须先经过本机用户审批。

阶段 6 已实现该状态机。hello/welcome 必须在 10 秒内完成；welcome 必须回显 hello 的 connection nonce，且握手消息 senderId 必须等于设备信息中的 deviceId。连接后双方每 10 秒发送 heartbeat，30 秒未收到任何有效消息即断开。入站设备展示 IP 以 TCP socket 来源为准，不信任 hello 中自报的 IP。

## 文字消息

`text:send` 包含非空 `content` 与 `text | link` 类型。接收方完成本地投影后发送 `text:ack`，其 payload 中的 messageId 指向被确认的 `text:send`。链接分类仅用于 UI 展示；打开链接必须由用户主动触发并再次校验 URL scheme。

阶段 7 已实现这些消息。发送前 IPC 与协议 schema 都按 UTF-8 字节数执行 64 KiB 限制；接收端只接受当前已审批连接中 senderId 与对端设备 ID 一致的消息。发送任务只有在 10 秒内收到对应 `text:ack` 后才标记完成。`link` 只表示整个正文可解析为 `http:` 或 `https:` URL，不赋予自动打开或其他执行能力。

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

文件元数据只包含 fileId、展示名、大小和 MIME type，不包含发送方路径或接收方保存路径。展示名必须是 Windows/macOS 可移植的单个路径段：不得使用 Windows 保留名、非法字符或尾随点/空格，UTF-8 编码不得超过 255 字节。0 字节文件合法，单文件最大 2 GiB。MIME type 仅用于展示，不作为安全判断依据。

结构 schema 验证单条消息。主进程使用有界时间窗口拒绝重复 messageId；协调器进一步校验 offer/accept 文件集合、逐文件顺序、fileId、进度单调性与上限、完成消息状态、完成大小和任务归属。transferId 完成后仍在有界时间内保留，使用新 messageId 重放旧 offer 同样会被拒绝。多文件严格串行上传，接收端只接受当前队首的 HTTP 请求；同一方向一次只允许一个活动文件任务。

## HTTP 上传

接收方接受文件后，发送方逐文件调用：

```text
POST /v1/transfers/:transferId/files/:fileId
Authorization: Bearer <one-time-upload-token>
Content-Type: application/octet-stream
Content-Length: <accepted-file-size>
```

文件名和保存路径不出现在 URL。服务端核对一次性 token、来源 IP、connectionId、transferId、fileId、精确 Content-Length、固定 Content-Type 和过期时间，不接受 `Transfer-Encoding`。token 在第一次合法上传尝试时立即消费，重复上传返回 HTTP 409。上传双方使用 30 秒空闲超时。

接收方接受前检查目录和可用空间，上传写入接收目录内以 `0600` 独占创建的随机 `.part` 文件；收到超过 offer 的字节数会立即中止。完整关闭并核对大小后才以不覆盖方式发布最终文件；失败响应不会返回本机路径或内部错误详情。HTTP 请求与 WebSocket Upgrade 按来源进行有界限流，触发 HTTP 限流时返回 429。严格匹配文件上传路由的请求使用独立的高容量速率桶，以支持文件夹内大量小文件；健康检查、未知路径和其他请求继续使用低容量通用速率桶。上传路由仍必须通过 session、来源 IP、传输状态、一次性 token、文件顺序和长度校验。

`file:cancel` 不带 fileId 时取消整个任务，携带 fileId 时只取消该文件。已完成文件不回滚。重试不是协议内恢复操作，而是发送方创建全新的 `file:offer`，不得复用原 transferId、fileId 或 upload token。

## 1.2 文件夹消息

阶段 3 已实现 `folder:offer`、`folder:manifest`、`folder:accept` 和 `folder:reject`。offer 只发送摘要；最大 2 MiB manifest 拆成最多 32 个、单个目标上限 96 KiB 的严格分片，接收端完成索引、容量、汇总值、SHA-256、重复 ID 和跨平台路径冲突校验后才允许用户确认。

阶段 4 已实现 `folder:cancel`、`folder:progress`、`folder:complete` 和 `folder:error`。progress 同时携带当前 fileId、当前文件字节数和任务累计字节数，接收端与发送端执行单调性、文件上限、任务上限和队列状态校验。complete 使用 `file | folder` scope：逐文件确认精确大小，folder scope 确认全部内容已进入暂存树。cancel 当前取消整个文件夹任务，不支持保留其中部分文件。

文件夹接受消息发送一个任务级 uploadKey 和过期时间。逐文件 token 由 HMAC-SHA-256 绑定 transferId 和 fileId 派生；HTTP 请求还绑定活动连接、来源 IP、当前队首、精确 Content-Length、固定 Content-Type 和一次性消费状态。文件通过 `POST /v2/folder-transfers/:transferId/files/:fileId` 串行上传，URL 不携带相对路径，目标位置只能来自已验证 manifest。

阶段 5 起，接收端内容完整时先进入 `publishing`，只有最终目录安全发布成功后才发送 folder-scope `folder:complete`；发送端收到该消息后进入 `completed`。发布失败使用 `folder:error` 携带 `FOLDER_PUBLISH_FAILED`，双方都不得把 staging 内容显示为成功。重试是新的 offer，必须更换 transferId、manifestId、全部 fileId 和 uploadKey。

阶段 6 的串行队列是本机主进程调度能力，不新增或改变网络消息。队列逐项调用既有 text、file 或 folder 流程；下一项只有在上一项收到确认并进入终态后才开始，因此对端看到的仍是独立、可准确失败和重试的协议任务。

阶段 8 强制 manifest 的文件路径和空目录路径分别严格升序。接收端在保存每个分片前限制其编码内容为 96 KiB，并持续校验累计条目、累计文件大小和 2 MiB 部分 manifest；除“完全空文件夹的唯一分片”外拒绝空分片。完整 manifest 仍必须与 offer 的数量、总大小和 SHA-256 完全一致。终态 folder transferId 在有界 24 小时窗口内拒绝再次作为 offer 使用。

相对路径在协议中统一使用 `/`，拒绝绝对路径、盘符、UNC、反斜杠、空段、`.`、`..`、非法跨平台文件名、超深和规范化冲突。详细 manifest、状态机和发布规则见 [文件夹传输设计](folder-transfer.md)。

## 错误

协议只使用 `src/shared/errors` 中的稳定错误码。中文文案由接收端本地映射，不作为协议判断依据，也不随网络错误消息传输。
