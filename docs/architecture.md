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
- 时间偏差、消息去重、消息顺序、连接状态和传输状态属于有状态校验，由后续主进程协调器负责。
- IPC 使用固定 channel 列表及 request/response/event 映射；Preload 和主进程不得重复声明契约。
- 网络协议内部的一次性上传 token 不进入渲染进程 DTO。

## Electron 安全边界

主窗口固定启用 `contextIsolation`、sandbox 和 `webSecurity`，关闭 Node integration、不安全混合内容及 webview。renderer 发起的页面导航、新窗口和权限请求默认拒绝，外部 HTTP/HTTPS 链接只能通过经过校验的主进程 handler 打开。

Preload 暴露冻结的 `window.lanTransfer` 分域 API，不暴露 `ipcRenderer`、通用 `send`、通用 `invoke` 或 Electron event。事件订阅只传 DTO，并返回明确的取消订阅函数。

IPC handler 必须同时满足：

- channel 在 shared 白名单中并拥有对应请求 schema；
- 调用来源是当前主窗口的 main frame；
- 参数通过 strict Zod schema，未知字段被拒绝；
- 返回值使用统一 `OperationResult`，异常细节不直接传给 renderer。

阶段 4 只注册安全外链和剪贴板 handler。其他 Preload 方法保留稳定类型，但在对应业务阶段注册 handler 前默认不可调用。
