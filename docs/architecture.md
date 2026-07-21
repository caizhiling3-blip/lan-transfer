# 架构设计

应用由 Electron 主进程、sandboxed Preload、Vue 渲染进程和 shared 代码组成。

- 主进程负责窗口、网络、文件、IPC、持久化和日志。
- Preload 只通过 `contextBridge` 暴露有类型的最小 API。
- 渲染进程负责界面和状态展示，不直接访问 Node.js 或 Electron。
- shared 存放跨进程共享且不依赖运行环境的类型、协议、错误码和常量。

安全窗口配置固定为 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。

HTTP 与 WebSocket 服务、状态机及安全边界将在对应阶段补充为实现级文档。
