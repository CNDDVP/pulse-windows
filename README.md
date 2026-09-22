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
- **StepFun / 阶跃星辰**：API Key 或 **网页扫码登录**（Windows 原生 CookieManager 穿透 HttpOnly 捕获 Oasis-Token），**Token 到期前自动无感续期**，24h 积分消耗图表与加油包独立识别。
- **Kimi Code** / **OpenCode Go** / **DeepSeek** / **GitHub Copilot** / **MiniMax** / **Grok** / **火山引擎** / **Command Code** / **Devin (Windsurf)** / **Ollama** / **智谱清言** 等全线支持。

### 🧮 本地 Token 消耗审计引擎（Token Spend）与费用估算

- 内置高性能 SQLite 缓存与流式日志解析器，支持对 **Claude Code**、**Codex**、**Gemini**、**Cline**、**Roo Code**、**Kilo Code**、**OpenClaw**、**ZCode CLI**、**Qwen CLI**、**OpenCode**、**Kiro CLI**、**Cherry Studio** 进行多维本地使用量聚合与审计；各来源可按设置追加自定义扫描目录（`token_spend_extra_paths`，每来源上限 20 条，绝对路径），缺失目录静默跳过。
- **WSL 用量（opt-in，默认关）**：开启后经 `wsl.exe` 只读读取**默认发行版**内的 Claude Code / Qwen Code 会话日志（`~/.claude/projects`、`~/.qwen/projects`，仅 `.jsonl` 文件型来源），与 Windows 侧同来源合并统计；文件路径键加 `wsl:` 前缀，同会话双侧重复按事件 id 折叠不双计。命令构造防注入：读取/发现一律 `wsl.exe -e` 直接 exec（不经 shell），路径过严格字符白名单后才参与命令。独立文件数预算 2000、单文件上限 256KB；`wsl.exe` 不可用/超时/发行版无数据一律静默降级并在统计说明（notes）中标注。**不做** SQLite 类来源（如 OpenCode 的 storage 库）的 WSL 读取——需在发行版内运行 headless agent，复杂度与收益不成比例，此类来源仅支持 Windows 侧。
- **Discord 状态广播（opt-in，默认关）**：开启后 Pulse 仅在**本机**与 Discord 客户端通过本地 IPC（命名管道）通信，每 60 秒节流更新一次聚合状态——「正在写代码/空闲」（复用活动灯信号）、已启用账号数、今日 token 总量（与趋势面板当日值同口径，需同时开启 Token 消耗统计）。**不广播**账号名、供应商名或任何明细，payload 只含聚合数字；Discord 未运行或连接失败一律静默忽略。⚠️ 前置条件：需在 [Discord Developer Portal](https://discord.com/developers/applications) 注册应用并取得 Client ID，通过环境变量 `PULSE_DISCORD_CLIENT_ID` 提供；未配置时该功能保持不可用（同样零 IPC 行为），Pulse 不内置任何第三方应用 ID。
- 内置主流公有云模型单价库，自动估算历史 Token 的云端美金费用。

### 🔔 通知、快捷键与应用内更新

- **分级预警通知**：额度越过 75% / 90% 阈值、耗尽、窗口恢复、余额不足均可提醒，每件事只说一次。
- **全局快捷键**：显示/隐藏悬浮栏、打开设置均可自定义注册。
- **应用内更新中心**：检查 / 下载 / 取消 / 应用升级全生命周期可视化，升级期间关键操作自动守卫阻断。
- **极致轻量**：内存开销仅约 20~35 MB，CPU 占用日常接近 0%。

---

## 📊 支持的供应商与数据路线

Pulse 展示的每个百分比都来自服务商自身的应答——使用各产品自己的客户端路由（文档化接口、编辑器登录、本地语言服务器），不存在"Pulse 服务器"中转，也不要求统一的官方配额 API。在这条原则之上，能力分为两类数据路线：**实时额度引擎**（`src-tauri/src/providers/`，凭你的凭据向服务商接口查询）与**本地日志审计**（`src-tauri/src/ledger.rs`，只读解析本机会话日志，不发起任何网络请求）。Claude Code 与 Codex 两条路线兼备。下表中 ✅ 表示该能力在当前代码已实现，"—" 表示该路线不提供或尚未实现此能力。

| 供应商 | 数据路线与认证 | 实时额度限制 | Token 用量审计 | 会话明细 |
|---|---|---|---|---|
| **Claude Code** | `~/.claude` 本地 OAuth 会话自动探测（`CLAUDE_CONFIG_DIR` 可覆盖），或手动填 Token → 官方 OAuth 用量接口 | ✅ 5 小时会话 + 每周限额窗口（兼容新旧两代应答格式） | ✅ `~/.claude/projects` 会话日志流式解析 | 活动灯：按本地会话日志判定工作/空闲 |
| **Codex / ChatGPT** | `~/.codex/auth.json` OAuth 自动探测（`CODEX_HOME` 可覆盖），或手动填 Token → ChatGPT 后端用量接口 | ✅ 账户主/次限额窗口 + 附加限额分组 | ✅ `~/.codex/sessions`（含归档目录），累计值差分防重复计数 | 活动灯：按本地会话日志判定工作/空闲 |
| **Cursor** | 本地编辑器 `state.vscdb` 自动提取登录态，Cookie 直连官方用量接口 | ✅ 专属模型 / 其他模型 / 额外消费三个窗口 | — | — |
| **Google Antigravity** | 自动探测本地 `language_server` 进程，动态解析 `--csrf_token` 调本地 RPC，无需凭据 | ✅ 按模型组的 5 小时 / 每周剩余桶 | — | 活动灯：监测语言服务器请求流 |
| **StepFun / 阶跃星辰** | API Key 或网页扫码登录（Windows 原生 CookieManager 捕获 Oasis-Token），Token 到期前自动无感续期 | ✅ 5 小时 / 每周限额 + Credit 套餐窗口 + 加油包按过期时间独立识别 + CNY 余额 | — | ✅ 24 小时按模型积分明细图表 |
| **Kimi Code** | API Key（凭据管理器）→ Kimi Coding 官方用量接口 | ✅ 按模型 5 小时/每日/每周限额窗口 + 请求级 5h/7d 窗口 | — | 活动灯：监测 Kimi Code IDE 事件流 |
| **GitHub Copilot** | 本地 `github-copilot` 登录缓存自动探测，或手动填 Token → Copilot 配额快照接口 | ✅ 高级交互 / 聊天 / 代码补全三快照（区分 unlimited 与真正额度） | — | — |
| **Grok** | `~/.grok/auth.json` 本地探测 → 官方账单接口 | ✅ 账单周期内账户共享 Credit 额度池 | — | — |
| **Grok Bot** | Cursor 登录态（Cookie）→ Sand 用量接口 | ✅ 每周个人额度（严格剔除企业共享配额） | — | — |
| **OpenCode Go** | 本地 `opencode/auth.json` 自动探测 → 官方用量接口 | ✅ 5 小时滚动 / 每周 / 每月三窗口 | — | — |
| **z.ai** | API Key → 限额监控接口 | ✅ Token / 积分 / 请求频次多级窗口（5 小时 / 每周 / 每日 / MCP 每月） | — | — |
| **智谱清言** | API Key → bigmodel 限额监控接口 | ✅ 与 z.ai 同族解析路线 | — | 活动灯：监测 ZCode CLI 事件流 |
| **MiniMax（国际版）** | API Key → 国际版接口，双接口自动回退 | ✅ 按模型区间窗口 + 每周窗口 | — | — |
| **MiniMax（国内版）** | API Key → 国内版接口，双接口自动回退 | ✅ 同国际版解析路线 | — | — |
| **DeepSeek** | API Key → 官方余额接口 | 仅余额（多币种），无额度窗口 | — | — |
| **火山引擎** | API Key（AWS SigV4 请求签名）或本地 `arkcli` 命令行读取 | ✅ Coding 5 小时额度 + AFP 周额度 | — | — |
| **Command Code** | `~/.commandcode/auth.json` 本地探测 → 聚合接口 | ✅ 5 小时 / 每周限额窗口 + Credit 余额 | — | — |
| **Devin (Windsurf)** | 官方接口凭据，或 Windsurf 本地 `state.vscdb` 零凭据读取 | ✅ 每日 / 每周窗口；本地库时间戳缺失或过期时标记 `unverified`，不充当实时读数 | — | — |
| **Ollama Cloud** | ollama.com 会话 Cookie | ✅ 5 小时会话 + 每周双窗口 | — | — |
| **小米 Coding Plan** | 会话 Cookie → 控制台接口 | ✅ 套餐桶用量百分比 + CNY 余额（接口未上报周期长度，故无时间环） | — | — |
| **Gemini CLI** | 本地日志解析：`~/.gemini/tmp`（`GEMINI_CLI_HOME` 可覆盖），无网络请求 | — | ✅ `session-*` 会话文件流式解析 | ✅ 会话页签（会话列表 + 逐事件明细）；审计按天 / 小时 / 来源×模型聚合 |
| **Cline** | 本地日志解析：VS Code / Insiders / VSCodium 插件全局存储，无网络请求 | — | ✅ 各任务 `ui_messages.json` | ✅ 会话页签（同上） |
| **Roo Code** | 同 Cline 路线（`rooveterinaryinc.roo-cline`），无网络请求 | — | ✅ 各任务 `ui_messages.json` | ✅ 会话页签（同上） |
| **Kilo Code** | 同 Cline 路线（`kilocode.kilo-code`），无网络请求 | — | ✅ 各任务 `ui_messages.json` | ✅ 会话页签（同上） |
| **OpenClaw** | 本地日志解析：`~/.openclaw/agents`，无网络请求 | — | ✅ 会话 JSONL 流式解析 | ✅ 会话页签（同上） |
| **ZCode CLI** | 本地日志解析：`~/.zcode/projects` 与 `~/.zcode/v2/agent-config/claude`（Claude Code 同构转录）+ `~/.zcode/cli/db/db.sqlite`（CLI 信封权威根，`ZCODE_HOME` 可覆盖），无网络请求 | — | ✅ Claude 同构转录流式解析 + CLI 库 `model_usage` 表只读投影（真实数据实测）；`cli/agents`、`cli/rollout` 的 JSONL 信封与该库为同一批请求的重复记录，不收集（防双计） | ✅ 会话页签（同上；活动灯另监测 `cli/log` 事件流） |
| **Qwen CLI** | 本地日志解析：`~/.qwen/projects`（`QWEN_CONFIG_DIR` 可覆盖），无网络请求 | — | ✅ 会话 JSONL 流式解析（复用 Claude Code 同构分支；本机无该目录，未经真实数据验证） | ✅ 会话页签（同上） |
| **OpenCode** | 本地日志解析：`$XDG_DATA_HOME`/`~/.local/share` 下 `opencode/storage`（含旧版 `session/message` 布局），无网络请求 | — | ✅ `storage/message` 助手消息解析（按上游源码实现；本机无该目录，未经真实数据验证） | ✅ 会话页签（同上） |
| **Kiro CLI** | 本地日志解析：`~/.kiro/sessions/cli` 会话树（`KIRO_CONFIG_DIR` 覆盖 `~/.kiro` 根），无网络请求 | — | ✅ 会话头 `.json` 逐回合解析 Kiro 格式中唯一实测计数器（`input/output_token_count`），同名 `.jsonl` 侧车仅提供 prompt 时间戳；按上游 KiroReader 同构实现，本机无该目录，未经真实数据验证 | ✅ 会话页签（会话列表 + 逐事件明细）；审计按天 / 小时 / 来源×模型聚合 |
| **Cherry Studio** | 本地日志解析：`<app-data>/CherryStudio/Data/Agents/.claude/projects`（V2）与 `<app-data>/CherryStudio/.claude/projects`（legacy，`<app-data>` 为 `dirs::data_dir()` 平台规则、Windows 为 `%APPDATA%`），无网络请求 | — | ✅ Claude 同构转录流式解析：同一次调用流式落盘的 3~4 份快照按 requestId 身份折叠为一次调用（字段级最大值），V2 与 legacy 同名相对会话以 V2 为准；复用 Claude 同构分支字段形状，按上游 CherryStudioReader 同构实现，本机无该目录，未经真实数据验证 | ✅ 会话页签（同上） |

<details>
<summary><strong>诚实说明：能力边界与已知误差</strong></summary>

- **缺失不造假**：解析器遵守"数字缺失不是零"——服务商应答缺少数据时，账号显示具体错误或降级读数，不会伪装成 0% 或 100%。DeepSeek 只返回余额、没有任何额度窗口，应用如实只显示余额，不虚构百分比（均有单元测试断言兜底）。
- **周期长度可能是推断值**：部分接口只给窗口名称、不给周期长度，此时按标准命名推断（每周 = 7 天、每月 = 30 天等），存在约 ±1/30 的周期误差；推断不出名称的窗口（如 Antigravity 部分桶、小米套餐、Cursor 未命名窗口）不显示时间环与预测，而不是编造周期。
- **本地日志审计的天然缺口**：审计完全依赖各源工具自行写入的日志，源工具会按自身保留策略清理、轮转或归档会话日志，早于保留期的消耗无法统计。扫描设有目录深度（18 层）与文件数（10,000）预算，超限即标记截断；检测到统计缺口时界面显示"统计不完整 / 覆盖缺口"提示，而不是假装完整。Cline / Roo Code / Kilo Code、Gemini、OpenClaw、OpenCode 的解析事件一律带“部分统计”标记，Claude（ZCode CLI、Qwen CLI 同）在日志行缺少 id 或用量字段时同样降级；ZCode CLI 的 CLI 库投影中，非完成状态（error/cancelled）请求按真实消耗计入但标记“部分统计”；OpenCode、Qwen CLI、Kiro CLI、Cherry Studio 四条路线本机无数据目录，格式按上游源码 / Claude 同构假设实现，均属未经真实数据验证，工具布局变更时可能失效——其中 Kiro 只读其格式中唯一实测计数器（逐回合 input/output_token_count），Kiro 的 IDE/globalStorage 与 kiro-cli SQLite 库按上游同款结论只含估计值（上下文窗口×百分比、字符数÷4），不读取、不折算，宁缺毋假；Cherry Studio 流式落盘的同一调用多份快照按 requestId 身份折叠、身份全缺的行降级“部分统计”，V2 与 legacy 两根同名会话以 V2 为准、不双计；自定义扫描路径与默认扫描根之间只按文件路径去重：嵌套目录发现的同一文件路径相同、不会重复计数；跨目录复制的文件对事件 id 稳定的来源（Claude / ZCode / Qwen / Codex / Gemini / OpenClaw / OpenCode / Cherry Studio）在统计中按（来源，事件 id）折叠、同样不双计，但会重复解析并使文件计数翻倍；Kiro 会话头带 session_id 时同属此类（事件 id 为 {session}:{index}），缺失 session_id 的会话头事件 id 降级为 offset 兜底 id、按路径命名空间生成，这类复制件会按路径重复计入统计；Cline / Roo Code / Kilo Code 的事件 id 按路径命名空间生成、缺失 id 的事件降级为 offset 兜底 id，这些复制件会按路径重复计入统计，为这些来源（含缺 session_id 的 Kiro）配置自定义目录时应避免文件复制；Codex 事件本无逐行 id（按累计值合成），在累计值回退、缓存增量异常或模型未知时降级，缺用量字段的行直接跳过、不计入。
- **费用是估算值**：Token Spend 的金额按已知模型公开定价折算，仅供参考，不构成账单。
- **实测覆盖有限**：实时路线中 Kimi Code、OpenCode Go、Antigravity 做过真实凭据实测（见 `docs/provider-matrix.json`），其余路线以单元测试验证解析逻辑为主；服务商接口改版可能导致个别路线临时失效，失效时显示具体错误而非静默清零。
- **活动灯只是信号**：Claude Code / Codex / Kimi / 智谱 / Antigravity 五渠道的活动灯由本地日志事件流推断"工作 / 空闲"，不读取、不展示任何会话内容。

</details>

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
