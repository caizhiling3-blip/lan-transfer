# LAN Transfer

基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：阶段 8 单文件传输。应用支持设备连接、双向文字/链接，以及需要接收方确认的 HTTP 流式单文件传输、进度、速度、安全临时文件和同名文件避让。当前历史仅在应用进程内保存；多文件、拖拽、取消和重试将在后续阶段实现。

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
