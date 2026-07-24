# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：1.2 文件夹传输阶段 6（统一串行队列）。一次发送动作中的文字、文件批次和文件夹会在主进程按顺序排队，同一时刻只启动一个出站任务；文件与文件夹授权在入队时由主进程认领，长任务不会导致后续选择 token 过期。断线会清除尚未启动的内容，避免重连到其他设备后误发。完整边界见 [文件夹传输设计](docs/folder-transfer.md)。

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

## Windows 打包

建议在 Windows x64 环境执行：

```bash
pnpm package:win:dir
pnpm package:win
```

前者生成免安装目录用于快速冒烟测试，后者生成未签名 NSIS `.exe` 测试安装包。详细要求和验收步骤见 [发布指南](docs/release.md)。

## macOS 打包

```bash
pnpm package:mac:dir
pnpm package:mac:arm64
pnpm package:mac:x64
pnpm package:mac
```

`package:mac` 会依次生成 Apple Silicon 和 Intel 两个未签名 DMG。正式分发前必须完成 Developer ID 签名和 Apple notarization；测试安装与 Gatekeeper 说明见 [发布指南](docs/release.md)。

详细说明见 [开发文档](docs/development.md)。
