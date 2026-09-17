# Pulse for Windows (独立版)

1:1 像素级复刻 **[qunqin24/Pulse](https://github.com/qunqin24/Pulse)** 的 Windows 原生桌面 AI 编码额度监视器。

---

## 核心特性

- **屏幕边缘贴靠与微光折叠**：
  - 吸附于屏幕右边缘（或左边缘），具备与屏幕无缝融合的贝塞尔有机曲面底座（Bezier Bezels）。
  - **闲时自动折叠**：鼠标离开 3 秒自动滑入屏幕边缘，仅留出 3~4px 微光窄边；鼠标触碰立即平滑弹射展开。
- **状态环（Usage Rings）**：
  - 动态颜色感知：`<50%` 翠绿、`50%~75%` 明黄、`75%~90%` 橙红、`>90%` 绯红深警报。
  - 活动指示灯：当对应 Agent 处于活跃调用时，环边有白色微光旋转指示。
- **悬停详细气泡卡片（Hover Details）**：
  - 鼠标悬停任意圆环，滑出带尖角指示箭头的半透明气泡卡片，对准当前圆环。
  - 分组展示 5 小时会话窗口、每周限额、重置倒计时（例如 “41分钟后重置”、“2天后重置”）。
- **黑曜石与冰晶双主题**：
  - **黑曜石深色（Dark Obsidian）**：深邃质感、暗黑毛玻璃（对照截图 1）。
  - **冰晶浅色（Light Translucent）**：清透高雅白底微透明（对照截图 2）。
- **全量 18+ 提供商引擎（完全本地优先，零云端）**：
  - **Google Antigravity**：自动探测 Windows 本地 `language_server.exe` 进程，解析 `--csrf_token` 与本地端口，直连 RPC 获取实时配额。
  - **Cursor**：自动读取 `%APPDATA%\Cursor\User\globalStorage\state.vscdb` 中的 Session Token，直连官方 API。
  - **Codex / ChatGPT**：自动读取 `%USERPROFILE%\.codex\auth.json` 获取 OAuth Token。
  - **Claude Code**：自动检测 `~/.claude` 本地会话或支持自定义 Token。
  - **Kimi Code** / **DeepSeek** / **GitHub Copilot** / **MiniMax** / **Grok** 等。
- **独立设置窗口与托盘**：
  - 右键悬浮轨道或点击系统托盘图标，即可呼出独立设置面板。
  - 配置保存在本地明文：`%APPDATA%\pulse-windows\settings.json`。

---

## 快速启动

### 方式一：双击直接启动
双击项目根目录下的 **`launch.bat`**，即可直接启动编译好的发布版（仅 13.3 MB 单文件，内存 < 30MB）。

### 方式二：命令行启动
```bash
# 启动 Release 生产版本
.\src-tauri\target\release\pulse-windows.exe

# 或启动热重载开发环境
npm run tauri:dev
```

---

## 快捷操作指南

1. **悬停查看**：将鼠标移至屏幕边缘的圆环，卡片自动滑出，展示重置倒计时。
2. **打开设置**：在悬浮轨道或系统托盘图标上点击**右键**，选择“设置...”。
3. **手动刷新**：在系统托盘菜单中选择“立即刷新配额”。
4. **退出应用**：在系统托盘菜单中选择“退出 Pulse”。

---

## 技术架构

- **后端**：Rust (Tauri 2.0 + Win32 API + Reqwest + Rusqlite)
- **前端**：React 19 + Tailwind CSS + Framer Motion
- **内存开销**：日常驻留仅约 20~30 MB
- **授权**：MIT License
