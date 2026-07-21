# LAN Transfer

基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：阶段 9 多文件与拖拽。应用支持设备连接、双向文字/链接、1–20 个文件串行流式传输、拖拽、任务和单文件进度、取消与全新任务重试。当前历史仅在应用进程内保存。

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
