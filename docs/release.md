# 测试包发布指南

项目当前只生成未签名的 Windows/macOS 测试安装包，并通过 GitHub Releases 手动分发。仓库不包含代码签名、notarization、凭据校验或自动创建 Release 的流水线。

## 发布前检查

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Windows x64

```bash
pnpm package:win
```

输出为 `release/Lindu-Setup-<version>-x64.exe`。安装包使用 NSIS，可选择安装目录，并创建桌面及开始菜单快捷方式。

未签名安装包可能触发 Windows SmartScreen。下载页面必须明确标注测试版；用户只应在确认下载来源后继续运行。首次监听局域网端口时，只建议在受信任的专用网络允许 Windows Defender Firewall，默认 TCP 端口为 53317。

## macOS

```bash
pnpm package:mac:arm64
pnpm package:mac:x64
```

输出为：

- `release/Lindu-<version>-arm64.dmg`：Apple Silicon；
- `release/Lindu-<version>-x64.dmg`：Intel Mac。

测试包未签名且未 notarize。首次启动可能需要在 Finder 中右键应用并选择“打开”，或在“系统设置 > 隐私与安全性”中允许本次打开；不要全局关闭 Gatekeeper。

Info.plist 声明本地网络用途。自动发现使用 UDP 53318；组播被防火墙或网络隔离阻止时，仍可使用手动 IP/端口连接。

## 手动发布到 GitHub

1. 打开项目的 GitHub Releases 页面并创建新 Release；
2. 使用测试版标签，例如 `v0.5.0-beta.1`；
3. 勾选 `Set as a pre-release`，不要设为最新稳定版；
4. 上传 Windows EXE 与两种 macOS DMG；
5. 在说明中列出支持的平台、架构以及未签名警告；
6. 官网下载按钮使用该 Release 资产的固定 URL。

桌面应用不包含应用内更新功能。发布新版本后，由官网读取 GitHub Release 资产并提供下载，用户手动下载安装。

## 安装验收

发布前至少在真实 Windows 10/11 x64、macOS arm64，以及计划继续支持时的 Intel Mac 上验证：

- 安装、首次启动、图标、版本与资源；
- 本地网络权限、防火墙、自动发现与手动连接；
- 验证码配对、可信设备重连与取消信任；
- 文字、文件、文件夹、暂停、断线及重启恢复；
- 卸载后程序文件移除，用户设置和历史按设计保留。

未执行的真实设备项目不能以跨平台构建或自动化测试替代。
