# 邻渡

「邻渡」是一款基于 Electron、Vue 3 和 TypeScript 的 Windows/macOS 局域网文字与文件互传应用。

当前进度：阶段 13 macOS 打包配置。应用支持设备连接，并在统一时间线和编辑器中完成双向文字、链接与 1–20 个文件互传；文件可先加入待发送区，再随文字一起发送。传输页只保留内容时间线滚动，历史记录支持跨分页数据搜索和明确筛选，界面支持持久化深浅色模式。串行流式传输、拖拽、接收确认、进度、取消与全新任务重试均已实现；设备身份、设置、最近设备和有限传输历史会跨重启保存。Windows x64 使用 NSIS 安装包，macOS 分别生成 Apple Silicon 与 Intel DMG；第一版测试包均未签名。

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
