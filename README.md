# LAN Transfer

基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：阶段 11.5 传输体验优化。应用支持设备连接，并在统一时间线和编辑器中完成双向文字、链接与 1–20 个文件互传；文件可先加入待发送区，再随文字一起发送。串行流式传输、拖拽、接收确认、进度、取消与全新任务重试均已实现；设备身份、设置、最近设备和有限传输历史会跨重启保存。网络限流、消息时钟与状态校验、安全目录、磁盘预检、临时文件恢复清理和本地日志已启用。

## 环境要求

- Node.js 22.12 或更高版本
- pnpm 11

## 开发

```bash
pnpm install
pnpm dev
```

## 质量检查

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

详细说明见 [开发文档](docs/development.md)。
