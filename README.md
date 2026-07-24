# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：1.2 文件夹传输阶段 4（逐文件流与暂存树）。接收方同意后会在授权目录创建任务独占的隐藏 staging 目录；发送方使用任务级密钥派生的逐文件 HMAC token 严格串行上传，双方展示任务与文件进度、速度和取消状态。嵌套文件、0 字节文件与空目录已支持；全部内容完成后停留在“等待发布”，阶段 5 才创建最终可见目录、处理重名并写入历史。完整边界见 [文件夹传输设计](docs/folder-transfer.md)。

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
