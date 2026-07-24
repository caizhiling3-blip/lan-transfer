# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：1.2 文件夹传输阶段 5（安全发布与历史）。接收方在 staging 树完整后独占创建最终目录，通过 ownership marker 约束发布和失败清理；同名目录使用 `名称 (1)` 递增，绝不覆盖已有内容。双方只在最终目录发布成功后进入完成状态并写入文件夹历史；失败、取消和拒绝可使用全新的任务与授权重试。应用启动时会清理严格匹配且超过 24 小时的残留 staging/未完成目录。完整边界见 [文件夹传输设计](docs/folder-transfer.md)。

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
