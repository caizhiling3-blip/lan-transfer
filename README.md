# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前开发分支还提供测试版“手机扫码上传”：电脑创建五分钟二维码，手机在同一受信任局域网中通过浏览器选择文件，并由电脑确认接收。该链路使用局域网 HTTP，不等同于桌面协议 v3 的端到端加密，仅应在可信 Wi-Fi 中使用。

当前开发版本：v0.5.0。版本保留协议 v3 安全配对、端到端加密、完整性校验和可恢复传输。

项目当前只生成未签名的 Windows/macOS 测试安装包，并通过 GitHub Release 和官网手动分发，不包含应用内更新、代码签名、notarization 或正式发布流水线。系统可能显示 SmartScreen 或 Gatekeeper 警告。

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

`package:mac` 会依次生成 Apple Silicon 和 Intel 两个未签名 DMG；测试安装与 Gatekeeper 说明见 [发布指南](docs/release.md)。

详细说明见 [开发文档](docs/development.md)。
