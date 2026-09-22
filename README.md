<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="112" alt="Pulse for Windows">
</p>

<h1 align="center">Pulse for Windows</h1>

<p align="center">
  <b>轻量、优雅的 Windows 屏幕边缘 AI 编码额度悬浮监视器。</b><br>
  实时呈现 Claude Code、Codex、Cursor、Antigravity、Kimi Code、StepFun 等 18+ 供应商的剩余额度与速率限制，并提供本地 Token 消耗审计与费用估算。
</p>

<p align="center">
  <a href="https://github.com/CNDDVP/pulse-windows/releases/latest"><img src="https://img.shields.io/github/v/release/CNDDVP/pulse-windows?color=00A86B" alt="Latest Release"></a>
  <a href="https://github.com/CNDDVP/pulse-windows/actions/workflows/ci.yml"><img src="https://github.com/CNDDVP/pulse-windows/actions/workflows/ci.yml/badge.svg" alt="CI Build"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D6?logo=windows" alt="Windows 10/11 x64">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Rust-%E2%89%A51.75-DEA584?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-3DA639" alt="License"></a>
  <a href="https://github.com/CNDDVP/pulse-windows/stargazers"><img src="https://img.shields.io/github/stars/CNDDVP/pulse-windows?color=FFD700" alt="GitHub Stars"></a>
  <a href="https://github.com/CNDDVP/pulse-windows/releases"><img src="https://img.shields.io/github/downloads/CNDDVP/pulse-windows/total" alt="Downloads"></a>
  <a href="https://github.com/CNDDVP/pulse-windows/commits/main"><img src="https://img.shields.io/github/last-commit/CNDDVP/pulse-windows" alt="Last Commit"></a>
  <a href="https://github.com/CNDDVP/pulse-windows/issues"><img src="https://img.shields.io/github/issues/CNDDVP/pulse-windows" alt="Open Issues"></a>
</p>

<p align="center">
  <sub>零遥测 · 凭据经 Windows 凭据管理器加密 · 完全本地优先 · <b>简体中文</b></sub>
</p>

---

基于 **[qunqin24/Pulse](https://github.com/qunqin24/Pulse)**（macOS 原生 AI 编码额度监视器）的 **Windows 原生移植与增强版**——保留其功能语义与交互设计，并针对 Windows 深度适配：凭据管理器、多显示器、自由拖拽、通知与快捷键均为 Windows 原生实现。

采用 **Tauri 2 + Rust + React 19 + Win32 原生调用** 架构，针对 Windows 11/10 进行了深度适配与架构加固。

> **v0.6.6 亮点**：StepFun 网页会话链路 36 项复审闭环——自动续期死锁修复、多账号扫码隔离、用量明细分页与去重。完整变更见 [Release Notes](https://github.com/CNDDVP/pulse-windows/releases/tag/v0.6.6) 与 [CHANGELOG](CHANGELOG.md)。

---

## ✨ 核心特性

### 🗲 屏幕边缘贴靠与微光折叠

- 吸附于屏幕右边缘（或左边缘），具备与屏幕无缝融合的贝塞尔有机曲面底座（Bezier Bezels）。
- **闲时自动折叠**：鼠标离开数秒后自动滑入屏幕边缘，仅留出 3~4px 微光窄边；鼠标触碰立即平滑弹射展开。
- **自由浮动模式**：支持任意拖拽位置并防抖记忆保存，后台看门狗保护不强行弹回。

### 🎯 状态环（Usage Rings）与周期感知

- **额度动态颜色感知**：`<50%` 翠绿、`50%~75%` 明黄、`75%~90%` 橙红、`>90%` 绯红告警。
- **纯白 1.5px 外圈时间环**：清晰标识当前额度周期的流逝进度。
- **活动灯**：实时指示该账号是否正在产生工作信号（Claude Code / Codex / 智谱 / Kimi / Antigravity 五渠道日志监测）。

### 🪄 动画机器人（BotMark）

- 可选的动画小机器人替代供应商 Logo：会思考、上传、庆祝、警报——对账号状态实时反应，自带性格与多种身体形态，支持点击互动与"减少动态效果"降级。

### 🃏 独立详情卡片（0% 闪烁）

- 悬浮栏永久锁定 72px 宽度，详情卡片由预热独立的顶层半透明子窗口呈现，彻底杜绝整窗擦除与闪烁；卡片高度自适应内容。

### 🔌 全量 18+ 提供商引擎（完全本地优先，零数据上云）

- **Google Antigravity**：自动探测 Windows 本地 `language_server.exe` 进程，动态解析 `--csrf_token` 与本地 RPC 端口。
- **Cursor**：自动探测并读取本地会话 Token，直连官方 API。
- **Codex / ChatGPT**：自动探测 `~/.codex/auth.json` 获取 OAuth Token。
- **Claude Code**：自动检测 `~/.claude` 本地会话或支持自定义 Token。
- **StepFun / 阶跃星辰**：API Key 或 **网页扫码登录**（Windows 原生 CookieManager 穿透 HttpOnly 捕获 Oasis-Token），**Token 30 分钟无感续期**，24h 积分消耗图表与加油包独立识别。
- **Kimi Code** / **OpenCode Go** / **DeepSeek** / **GitHub Copilot** / **MiniMax** / **Grok** / **火山引擎** / **Command Code** / **Devin (Windsurf)** / **Ollama** / **智谱清言** 等全线支持。

### 🧮 本地 Token 消耗审计引擎（Token Spend）与费用估算

- 内置高性能 SQLite 缓存与流式日志解析器，支持对 **Claude Code**、**Codex**、**Gemini**、**Cline**、**Roo Code**、**Kilo Code** 进行多维本地使用量聚合与审计。
- 内置主流公有云模型单价库，自动估算历史 Token 的云端美金费用。

### 🔔 通知、快捷键与应用内更新

- **分级预警通知**：额度越过 75% / 90% 阈值、耗尽、窗口恢复、余额不足均可提醒，每件事只说一次。
- **全局快捷键**：显示/隐藏悬浮栏、打开设置均可自定义注册。
- **应用内更新中心**：检查 / 下载 / 取消 / 应用升级全生命周期可视化，升级期间关键操作自动守卫阻断。
- **极致轻量**：内存开销仅约 20~35 MB，CPU 占用日常接近 0%。

---

## 📊 支持的供应商与数据路线

Pulse 展示的每个百分比都来自服务商自身的应答——使用各产品自己的客户端路由（文档化接口、编辑器登录、本地语言服务器），不存在"Pulse 服务器"中转，也不要求统一的官方配额 API。

| 供应商 | 数据路线与认证方式 | 备注 |
|---|---|---|
| **Claude Code** | 自动检测 `~/.claude` 本地会话，或自定义 Token | OAuth 会话优先，Token 手填兜底 |
| **Codex / ChatGPT** | 自动探测 `~/.codex/auth.json` OAuth Token | 读取本地已登录凭据直连官方 API |
| **Cursor** | 本地会话 Token 自动探测 | 直连官方用量 API |
| **Google Antigravity** | 本地 Language Server RPC | 编辑器运行期间有效，动态解析进程参数 |
| **StepFun / 阶跃星辰** | API Key 或网页扫码登录（Oasis-Token + Cookie） | **30 分钟无感续期**、24h 积分图表、加油包识别、CNY 余额 |
| **Kimi Code / OpenCode Go / DeepSeek / GitHub Copilot / MiniMax / Grok / 火山引擎 / Command Code / Devin / Ollama / 智谱清言 等** | API Key 或本地已有登录凭据 | 配置即用，详见应用内添加账号向导 |

---

## 📥 下载与安装

Pulse for Windows 提供两种分发形态（均在 [Releases](https://github.com/CNDDVP/pulse-windows/releases/latest) 页面，随包附带 `SHA256SUMS.txt` 校验文件）：

| 分发版本 | 文件名 | 适用场景 | 说明 |
|---|---|---|---|
| **安装版 (Setup)** | `Pulse-<版本>-windows-x64-setup.exe` | 日常固定使用 | 基于 NSIS 当前用户安装，支持安装/升级/卸载，配置保存在 `%APPDATA%\pulse-windows`，支持开机自启 |
| **便携版 (Portable)** | `Pulse-<版本>-windows-x64-portable.zip` | 免安装、U 盘随身携带 | 解压即用，所有配置、账本与 WebView2 数据保存在同级 `data/` 目录中；支持从本机安装版一键导入配置 |

> [!NOTE]
> **系统要求**：Windows 11（推荐）或 Windows 10（x64）；Microsoft Edge WebView2 运行时（Windows 11 已默认自带，缺失时安装器自动引导安装）。

---

## 🔨 从源码构建

### 前置要求

- **Node.js**: >= 18.0.0
- **Rust**: >= 1.75.0（含 `x86_64-pc-windows-msvc` target）

### 编译步骤

```bash
# 1. 克隆代码仓库
git clone https://github.com/CNDDVP/pulse-windows.git
cd pulse-windows

# 2. 安装 Node 依赖
npm install

# 3. 运行完整测试门禁
npm test
npx tsc --noEmit
npx oxlint
cargo test --manifest-path src-tauri/Cargo.toml

# 4. 一键打包双版本（安装版 EXE + 便携版 ZIP）
.\scripts\bump-version.ps1 0.3.8    # 结构化改版：三处版本 + Cargo.lock 重新解析
.\scripts\build-dist.ps1 -OutputDir release-artifacts
```

产物将输出在 `release-artifacts/` 目录下，并自动附带 `SHA256SUMS.txt` 校验文件。

---

## 🔒 隐私与安全承诺（Zero-Telemetry）

Pulse 严格遵守开源透明与零遥测准则：

1. **零埋点与数据回传**：应用绝不向任何第三方或开发者服务器回传任何使用日志、遥测指标或统计数据。
2. **凭据安全保护**：API Key 与访问令牌**绝不存入明文配置文件**，而是全量交给 Windows 原生凭据管理器（Credential Manager，经系统 DPAPI 加密保护）。
3. **便携模式动态隔离**：便携版通过随机生成的 `profile_id` 关联凭据，同一电脑移动文件夹凭据自动保留；换机或跨用户使用时安全隔离，防止凭据外泄。

详细审计结论请阅读 [PRIVACY_AUDIT.md](docs/PRIVACY_AUDIT.md)。

---

## 🙏 致谢与开源许可

- 本项目基于上游优秀开源项目 **[Pulse (qunqin24/Pulse)](https://github.com/qunqin24/Pulse)**（遵循 Apache-2.0 许可证）进行 Windows 原生移植、增强与加固。
- 代码遵循 **[Apache-2.0 许可证](LICENSE)** 开源。
- 更多第三方依赖与矢量图标归属声明详见 **[NOTICE](NOTICE)**。
