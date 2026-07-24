# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：1.2 文件夹传输阶段 2（安全扫描与短期授权）。主进程已支持系统文件夹选择和文件/文件夹混合拖拽扫描，严格限制符号链接、路径、层级、数量、大小、扫描时间和 manifest 内存；renderer 只获得文件夹摘要与 10 分钟 token。folder offer 和实际发送将在阶段 3 接入。完整边界见 [文件夹传输设计](docs/folder-transfer.md)。

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
