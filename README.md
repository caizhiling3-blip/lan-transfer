# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：1.2 文件夹传输阶段 1（需求与协议设计）。1.1 已支持自动发现、手动连接以及文字、链接和 1–20 个文件互传；1.2 将按独立阶段增加安全文件夹扫描、manifest 分片、逐文件流式上传、临时目录发布、多任务队列和后台通知。完整边界见 [文件夹传输设计](docs/folder-transfer.md)。Windows x64 使用 NSIS 安装包，macOS 分别生成 Apple Silicon 与 Intel DMG；当前测试包均未签名。

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
