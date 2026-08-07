# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前候选版本：v0.5.0。版本保留 v0.4.0 的协议 v3 安全配对、端到端加密、完整性校验和可恢复传输，并增加 Windows/macOS 正式签名配置、固定 GitHub Releases 更新源、由用户控制的检查/下载/安装、安全退出协调和可审计 Draft Release 流水线。

自动化与候选包结构检查不能替代真实设备验收。在 Windows/macOS 双机配对、抓包、Keychain/DPAPI、代码签名、notarization、安装、更新和重启恢复矩阵全部签字前，v0.5.0 不标记为正式双平台发布。完整范围见 [v0.5.0 设计](docs/v0.5.0.md) 和 [测试指南](docs/testing.md)。

v0.4.0 保留包作为升级基线；最终集中验收在 v0.5.0 签名候选包上分别记录 v0.4.0 安全传输回归与 v0.5.0 分发更新结果。真实签名凭据未注入时只能生成未签名结构检查包，不能宣称正式签名通过。

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
