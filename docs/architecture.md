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

### 局域网自动发现

`DiscoveryManager` 仅在本机 HTTP/WebSocket 服务处于 running 时启动 Node UDP4 socket，在 `239.255.53.17:53318` 发送 TTL 为 1 的组播广告，每 5 秒刷新一次。主进程为每个有效非回环 IPv4 网卡分别加入组播并发包，同时向各网段定向广播地址发送同一广告，避免 VPN、扩展坞或多网卡让系统选择错误出口。广告只包含应用标识、协议版本、消息 UUID、设备 ID、设备名、操作系统、服务端口和时间戳，不包含文件、路径、历史、连接 token 或上传授权。

接收端使用严格 Zod schema、8 KiB 数据报上限、时间偏差和 IPv4 来源校验；展示地址始终取 UDP 数据报来源，不信任广告自报地址。自身广告会被忽略，附近设备最多保留 50 台，超过 16 秒未出现即过期。renderer 只能通过只读 IPC 取得发现快照和变化事件；连接按钮仍调用 `ConnectionManager.connect`，因此发现不会绕过用户审批、单连接限制或握手验证。组播不可用时手动 IP/端口仍可使用。

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

本机设备 ID 首次启动时使用安全随机 UUID 生成，随后由阶段 10 的设置 store 跨重启保持稳定。主机名只作为首次启动默认设备名称，用户设置会用于后续握手。

## 文字传输

`ConnectionManager` 是文字网络状态的事实来源。只有已完成握手的活动 socket 可以发送或接收 `text:send`；收到消息时还会核对 envelope 的 senderId 与当前对端设备 ID，避免连接内身份替换。接收方把文字投影到本地后返回 `text:ack`，发送方只有收到对应 messageId 的确认才把任务标记为 completed，连接关闭或确认超时则标记为 failed。主进程把接收事件和发送结果转换为只读 IPC DTO，renderer 不接触 WebSocket。

文件协议中的 displayName 必须是 Windows 和 macOS 都可安全表示的单个路径段。发送端清洗路径分隔符、控制字符、Windows 保留名、非法字符、尾随点/空格和超长 UTF-8 名称，接收端协议 schema 再次校验。

文字记录先进入有上限的 `SessionHistory`，随后同步到阶段 10 的持久历史 store。传输页读取最近 100 条文字摘要，独立历史页提供方向、类型和状态筛选及分页查询。

renderer 使用 Pinia 维护文字页投影：进入页面时读取会话历史并订阅接收事件，离开页面时取消订阅。链接分类只接受完整的 HTTP(S) URL；外部打开仍经过主进程 scheme 校验并要求用户点击。

## 文件传输

`FileTransferCoordinator` 维护发送和接收任务，renderer 只接收任务 DTO：

1. Electron 系统文件选择器在主进程读取文件元数据，把真实路径绑定到十分钟有效、单次消费的 selection token；renderer 只把文件元数据暂存在待发送区；
2. 协调器通过 WebSocket 发送包含 1–20 个文件元数据的 offer；接收方必须拒绝、接受到默认 Downloads，或通过系统目录选择器为本次授权目录；
3. 接受后生成与 transferId、fileId、当前 connectionId、对端 IP、长度和期限共同校验的一次性 upload token；
4. 发送方使用 Node HTTP 流上传，renderer 不读取文件内容或路径；
5. 接收方独占创建随机 `.part` 文件，流结束且字节数吻合后创建不覆盖的最终硬链接，再删除临时名称；同名文件使用 `name (1).ext` 递增；
6. 失败、断线或退出会终止活动流并清理临时文件，磁盘和权限错误映射为稳定错误码。

HTTP 服务只把精确上传路由交给协调器，其他路径保持 404。上传要求固定 Content-Length，不接受远端文件名或保存路径；任务进度事件和 WebSocket 进度消息分别节流。

阶段 9 在同一任务内严格按 offer 顺序逐文件上传，接收端拒绝并行或乱序请求。任务总进度由所有文件累计，每个文件单独记录状态、字节数和速度。串行授权的截止时间按队列位置递增，每个文件保留一个传输超时窗口，避免后续文件尚未开始 token 就失效。取消整个任务会终止当前流并取消未开始文件；取消某个当前或待传文件不会回滚已成功文件，其余队列继续。发送方重试失败、拒绝或取消任务时会生成新的 transferId、fileId、offer 和授权，旧 token 永不复用。

1.1 在文件任务进入 `transferring` 时由主进程启用 Electron `powerSaveBlocker` 的应用挂起阻止器，最后一个传输离开该状态后立即释放。退出应用若仍有 pending、awaitingAcceptance、accepted 或 transferring 文件任务，会要求用户继续传输或明确退出并取消。预计剩余时间由 renderer 使用剩余字节和当前任务速度计算，只作提示，不改变传输事实。接收成功后的实际发布路径只保存在协调器内部，“在文件夹中显示”IPC 只接受 transferId 和可选 fileId，不接受 renderer 路径。

拖拽使用 Electron `webUtils.getPathForFile`，该调用封装在 Preload 内。renderer 只能把浏览器 `File` 对象交给具名 API，不能提交字符串路径；主进程重新执行数量、普通文件、大小和名称检查后才签发 selection token。文件夹拖入会被拒绝。

## 1.2 文件夹传输架构

文件夹传输复用现有 ConnectionManager、HTTP 服务、接收目录授权、任务事件和历史边界，但使用独立 FolderTransferCoordinator，避免把目录扫描、manifest 分片和目录发布状态塞进现有单文件协调器。两类协调器输出 shared 中的判别联合任务 DTO，renderer 继续只显示主进程事实状态。

主进程扫描器拥有真实根路径和逐文件身份快照；Preload/renderer 只持有短期 selectionToken 与摘要。最大 2 MiB manifest 以最多 32 个 WS 消息分片传输，接收端在有界 assembler 中校验后才投影 offer。HTTP 路由只使用 transferId/fileId 查找已验证相对路径，不接受 URL、header 或 renderer 提供的目标路径。

阶段 2 已实现 `scanFolder` 和 FileAccessRegistry 文件夹授权。扫描对规范化路径使用跨平台确定性排序，逐项 lstat/realpath 并验证仍位于根目录；普通文件记录设备号、inode、大小和修改时间。混合拖拽先验证所有顶层项，全部成功后才把文件和文件夹 token 写入有界注册表，避免部分失败留下 renderer 不可见的授权。

接收内容先进入授权目录中的任务 staging 目录。整个树完整后独占创建新的最终目录，并以 ownership marker 约束发布失败和启动清理只能作用于当前任务创建的目录；不使用可能覆盖空目录的跨平台 rename 假设。详细设计见 [文件夹传输设计](folder-transfer.md)。

## 统一传输体验

阶段 11.5 只合并 renderer 的交互投影，不改变网络协议或传输事实来源。文字、链接和文件任务按 `createdAt` 合并为一个有判别字段的 `TransferActivity` 时间线；文件任务仍由主进程协调器维护，文字和文件仍分别使用 WebSocket 控制与 HTTP 流式上传。

页面底部只有一个编辑器：用户可输入文字或链接、通过系统选择器添加一个或多个文件，或把文件拖入编辑器。文件先显示在待发送区，可逐个移除或清空；点击“发送”或按 Enter 时先发送非空文字，再发起一个文件 offer，Shift+Enter 保留换行。输入法组合输入期间不会触发发送。两种内容在时间线上仍是独立记录，因此任一部分失败都能给出准确状态，也不需要扩展第一版协议为复合消息。收到的文件 offer 直接在对应文件卡片内接受、改选目录或拒绝，不再显示与时间线分离的弹窗区。

传输页面使用固定视口高度，外层主内容区不滚动，只有活动时间线拥有滚动条；编辑器和连接状态始终可见。其他页面继续使用主内容区滚动。文件明细默认折叠，用户按需展开。

## 界面主题与历史搜索

renderer 使用 `light | dark` 两种纯界面主题，首次运行跟随系统偏好，用户切换后写入浏览器 `localStorage`。根元素同时设置 `dark` class 和 `data-theme`，Element Plus 使用官方 dark CSS variables，项目自有组件使用统一 `--app-*` 变量。主题不进入主进程或网络协议，也不扩大 Preload API。

暗色根节点进一步统一卡片、表格、描述列表、表单控件、弹窗及下拉浮层的背景、边框和文字层级，避免局部组件仍使用浅色填充。Logo 使用 Vite `?no-inline` 强制输出为同源 SVG 文件，以满足现有 `default-src 'self'` CSP；不会为了显示图片而放宽到任意 `data:` 图片。

历史搜索通过既有 `history:list` IPC 的可选 `query` 字段完成，最长 200 字符。主进程在分页前对文字摘要、文件名、对方设备名和 IP 做 Unicode 规范化及不区分大小写匹配；renderer 不读取本地 store，也不只过滤当前页。

## 本地存储与设置

阶段 10 使用仅运行于主进程的 `electron-store`，在 Electron `userData` 目录中维护三个原子写入的 JSON store：

- `settings`：schema 版本、稳定设备 ID、设备名、默认接收目录、服务端口、单文件上限和历史上限；
- `recent-devices`：按设备 ID 去重的最近 20 台设备及最后连接时间；
- `history`：按设置上限裁剪的文字、链接和文件传输摘要。

每个 store 在读取前使用严格 Zod schema 校验。非法或损坏文件会改名为带时间戳的 `.invalid-*` 备份，然后恢复安全默认值；`schemaVersion` 为后续显式迁移保留。文字历史只保存最多 500 个字符的预览，不保存文件内容、内部路径或上传授权。

`SettingsStore` 是设备身份和运行配置的事实来源。修改端口时先尝试重启服务，失败则恢复旧端口且不持久化新值；修改历史上限后立即裁剪旧记录。默认目录只能来自系统目录选择器的一次性 token。文件大小设置同时作用于发送端文件选择和接收端 offer 校验，并且不能突破 2 GiB 硬上限。

连接进入 `connected` 时更新最近设备，首页用最新设备预填地址但不会自动连接。历史页面通过有界分页 IPC 查询、筛选和清空；renderer 从不直接打开 store 文件。

## 异常与安全加固

阶段 11 在既有结构校验外增加有状态安全边界：

- HTTP 请求和 WebSocket Upgrade 按来源地址使用有界固定窗口限流，服务器同时限制连接数、header 大小和解析器行为；连接内控制消息另有限速。
- WebSocket 只接受文本 JSON，拒绝二进制控制帧；消息时间戳只能在本机时间前后 5 分钟内，sender、connectionId、消息顺序和进度边界继续由状态机核对。
- 上传必须使用精确 `Content-Length` 和 `application/octet-stream`，禁止 `Transfer-Encoding`；一次性 token 首次尝试即消费，重复上传返回冲突。
- 文件 offer 等待接受最长 5 分钟；HTTP 上传双方使用 30 秒空闲超时，心跳断线仍会终止传输并清理临时文件。
- 发送端拒绝符号链接，保存选择时记录文件设备号、inode 和修改时间，上传前通过已打开文件句柄再次核对，降低选择后替换文件的风险。
- 接收目录必须是绝对、真实、可写且非符号链接目录；文件系统根、系统目录、应用数据目录和安装目录不能作为接收目录。接收端在接受和写入前预检磁盘空间，但仍以实际写入错误为最终依据。
- 临时文件以 `0600` 和独占创建写入；超量数据立即中止。最终文件通过不覆盖的硬链接原子发布，短暂文件锁有限退避重试；启动时只清理默认接收目录中超过 24 小时且名称严格匹配的 `.part` 文件。
- selection token、目录 token、messageId、transferId 和内存任务记录都有 TTL 或容量上限，避免长时间运行产生无界内存增长。

本地日志由主进程 `electron-log` 写入 Electron 标准日志目录并按 5 MiB 轮转。日志记录应用/服务生命周期、设备连接、文件 offer、任务状态、错误码和未处理错误堆栈；不记录文字正文、剪贴板内容、文件内容、上传 token 或文件完整路径。

## 桌面打包边界

electron-builder 使用稳定 `com.lindu.transfer` 标识构建 Windows NSIS 和 macOS DMG。渲染资源统一使用相对 URL，应用 Logo 的 SVG、ICO 和 ICNS 位于 `build/`，打包输出统一进入被 Git 忽略的 `release/`。

macOS 第一版分别输出 arm64 和 x64，避免 Universal 包体积及合并复杂度。测试包显式跳过代码签名、notarization 和 Hardened Runtime；正式发布必须把三者作为独立安全工作流恢复。Info.plist 声明直接局域网连接用途；1.1 使用原生 UDP 组播而非 Bonjour，因此无需声明 Bonjour service type。`afterPack` 钩子在未来签名前收紧 ATS，并移除邻渡没有使用的相机、麦克风、音频采集和蓝牙模板描述，避免打包模板扩大隐私表面。
