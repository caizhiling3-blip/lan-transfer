# LAN Transfer

基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：阶段 7 文字传输。应用支持手动连接与审批、设备信息、心跳和断线检测，以及文字/HTTP(S) 链接的双向发送、接收、复制和显式打开。当前历史仅在应用进程内保存；文件传输将在后续阶段实现。

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
