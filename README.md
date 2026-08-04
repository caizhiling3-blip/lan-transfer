# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前版本：v0.3.0。数据管理、最近设备、诊断日志和失败恢复功能已完成自动化验证与当前 macOS 构建机结构检查；真实 Windows/macOS 双机、安装、权限和防火墙矩阵仍须按测试文档签字后才能正式发布。完整范围见 [v0.3.0 设计](docs/v0.3.0.md)。

下一版本 v0.4.0 已完成安全设计和协议 v3 shared 契约，下一阶段实现由系统安全存储保护的本机身份与可信设备数据；完整路线见 [v0.4.0 设计](docs/v0.4.0.md)。

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
