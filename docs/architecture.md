# 架构设计

应用由 Electron 主进程、sandboxed Preload、Vue 渲染进程和 shared 代码组成。

- 主进程负责窗口、网络、文件、IPC、持久化和日志。
- Preload 只通过 `contextBridge` 暴露有类型的最小 API。
- 渲染进程负责界面和状态展示，不直接访问 Node.js 或 Electron。
- shared 存放跨进程共享且不依赖运行环境的类型、协议、错误码和常量。

安全窗口配置固定为 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。

HTTP 与 WebSocket 服务、状态机及安全边界将在对应阶段补充为实现级文档。

## 共享契约

`src/shared` 是跨进程类型、协议、错误码和常量的唯一来源，并且不依赖 Electron、Node.js 或 Vue。

- 网络消息使用严格 Zod schema 做无状态结构校验，TypeScript 类型由 schema 推导。
- 主进程 `protocol-state` 负责有界 messageId 去重和当前连接状态的消息类型白名单；时间偏差、文件消息顺序和传输状态由后续文件协调器继续补充。
- IPC 使用固定 channel 列表及 request/response/event 映射；Preload 和主进程不得重复声明契约。
- 网络协议内部的一次性上传 token 不进入渲染进程 DTO。

## Electron 安全边界

主窗口固定启用 `contextIsolation`、sandbox 和 `webSecurity`，关闭 Node integration、不安全混合内容及 webview。renderer 发起的页面导航、新窗口和权限请求默认拒绝，外部 HTTP/HTTPS 链接只能通过经过校验的主进程 handler 打开。

本地 WebSocket 服务拒绝带有浏览器 `Origin` 的 Upgrade 请求，避免任意网页跨站调用固定本地端口；桌面端设备连接使用不携带 `Origin` 的主进程 WebSocket 客户端。

Preload 暴露冻结的 `window.lanTransfer` 分域 API，不暴露 `ipcRenderer`、通用 `send`、通用 `invoke` 或 Electron event。事件订阅只传 DTO，并返回明确的取消订阅函数。

IPC handler 必须同时满足：

- channel 在 shared 白名单中并拥有对应请求 schema；
- 调用来源是当前主窗口的 main frame；
- 参数通过 strict Zod schema，未知字段被拒绝；
- 返回值使用统一 `OperationResult`，异常细节不直接传给 renderer。

阶段 4 只注册安全外链和剪贴板 handler。其他 Preload 方法保留稳定类型，但在对应业务阶段注册 handler 前默认不可调用。

## 本地服务

主进程的 `ServiceManager` 负责本地服务生命周期和 renderer 状态投影：

- 默认监听 `0.0.0.0:53317`，HTTP 与 WebSocket 共用一个 TCP 端口；
- Node HTTP server 只暴露健康检查和明确注册的路由，未知路由返回 404；
- WebSocket 使用 no-server Upgrade 模式，只接受 `/v1/ws`，禁用压缩并限制 payload 为 128 KiB；
- `/v1/ws` Upgrade 交给 ConnectionManager 完成设备握手；未安装连接处理器时使用 1013 关闭；
- `ServiceManager` 维护 stopped、starting、running、error 状态，端口占用映射为 `PORT_IN_USE`；
- 启动失败和监听后的运行时错误都会转成状态事件，不作为未处理异常退出应用；
- start、stop 和 restart 通过同一生命周期队列串行执行，启动中的退出或重复重启不会遗留 listener；
- 本机地址来自所有非 internal IPv4 网卡，不依赖 Windows 或 macOS 的固定网卡名称。

应用启动后自动启动服务；退出前关闭 WebSocket 客户端和 HTTP listener。阶段 5 的端口重启只影响当前运行实例，持久化设置留到阶段 10。

## 设备连接

`ConnectionManager` 同时处理主动连接和入站连接，并且只允许一个活动或待审批对端：

1. 主动方连接 `/v1/ws` 后发送 `device:hello`；
2. 入站方严格校验消息并用 socket 实际来源地址覆盖对端自报 IP；
3. renderer 显示设备名称、系统、IP 和端口，由用户允许或拒绝；
4. 允许后入站方生成 connectionId 并发送 `device:welcome`；
5. 双方进入 connected，每 10 秒发送 heartbeat，30 秒无消息判定超时；
6. 主动断开先发送 `device:disconnect`，socket close 仍作为最终清理依据。

连接、审批和握手分别有 10 秒超时。非法 JSON、错误消息类型或 connectionId 会关闭 socket。第二个入站 socket 使用 1013 拒绝，不替换当前连接。

hello 的 envelope senderId 必须与 deviceId 一致，welcome 必须回显本次 hello 的 connection nonce，避免把不属于当前握手的响应激活为连接。待审批请求同时保存在连接状态快照中；renderer 在应用根层订阅连接状态，因此页面切换或窗口重建后仍能恢复审批。

握手和连接态入站消息使用 10 分钟、最多 2000 条的 messageId 窗口去重。当前允许 heartbeat、disconnect、文字确认和文件控制消息出现在已连接状态。重复文字不会再次投影到历史，但会重发 ACK，允许发送方安全重试确认。

本机设备 ID 使用安全随机 UUID，并在单次应用进程内稳定；阶段 10 将其写入本地存储以实现跨重启稳定。主机名作为阶段 6 默认设备名称，设置页持久化名称同样留到阶段 10。

## 文字传输

`ConnectionManager` 是文字网络状态的事实来源。只有已完成握手的活动 socket 可以发送或接收 `text:send`；收到消息时还会核对 envelope 的 senderId 与当前对端设备 ID，避免连接内身份替换。接收方把文字投影到本地后返回 `text:ack`，发送方只有收到对应 messageId 的确认才把任务标记为 completed，连接关闭或确认超时则标记为 failed。主进程把接收事件和发送结果转换为只读 IPC DTO，renderer 不接触 WebSocket。

文件协议中的 displayName 必须是 Windows 和 macOS 都可安全表示的单个路径段。发送端清洗路径分隔符、控制字符、Windows 保留名、非法字符、尾随点/空格和超长 UTF-8 名称，接收端协议 schema 再次校验。

阶段 7 使用有上限的 `SessionHistory` 保存当前应用进程内的文字摘要，并通过既有 history IPC 提供最近 100 条记录给传输页。应用重启后这些记录会消失；设备 ID、设置、最近设备和历史的可靠持久化仍属于阶段 10，不提前引入 electron-store。

renderer 使用 Pinia 维护文字页投影：进入页面时读取会话历史并订阅接收事件，离开页面时取消订阅。链接分类只接受完整的 HTTP(S) URL；外部打开仍经过主进程 scheme 校验并要求用户点击。

## 文件传输

`FileTransferCoordinator` 维护发送和接收任务，renderer 只接收任务 DTO：

1. Electron 系统文件选择器在主进程读取文件元数据，把真实路径绑定到一分钟有效、单次消费的 selection token；
2. 协调器通过 WebSocket 发送包含 1–20 个文件元数据的 offer；接收方必须拒绝、接受到默认 Downloads，或通过系统目录选择器为本次授权目录；
3. 接受后生成与 transferId、fileId、当前 connectionId、对端 IP、长度和期限共同校验的一次性 upload token；
4. 发送方使用 Node HTTP 流上传，renderer 不读取文件内容或路径；
5. 接收方独占创建随机 `.part` 文件，流结束且字节数吻合后创建不覆盖的最终硬链接，再删除临时名称；同名文件使用 `name (1).ext` 递增；
6. 失败、断线或退出会终止活动流并清理临时文件，磁盘和权限错误映射为稳定错误码。

HTTP 服务只把精确上传路由交给协调器，其他路径保持 404。上传要求固定 Content-Length，不接受远端文件名或保存路径；任务进度事件和 WebSocket 进度消息分别节流。

阶段 9 在同一任务内严格按 offer 顺序逐文件上传，接收端拒绝并行或乱序请求。任务总进度由所有文件累计，每个文件单独记录状态、字节数和速度。串行授权的截止时间按队列位置递增，每个文件保留一个传输超时窗口，避免后续文件尚未开始 token 就失效。取消整个任务会终止当前流并取消未开始文件；取消某个当前或待传文件不会回滚已成功文件，其余队列继续。发送方重试失败、拒绝或取消任务时会生成新的 transferId、fileId、offer 和授权，旧 token 永不复用。

拖拽使用 Electron `webUtils.getPathForFile`，该调用封装在 Preload 内。renderer 只能把浏览器 `File` 对象交给具名 API，不能提交字符串路径；主进程重新执行数量、普通文件、大小和名称检查后才签发 selection token。文件夹拖入会被拒绝。
