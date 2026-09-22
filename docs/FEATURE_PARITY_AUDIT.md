# 功能对齐审计：Token Monitor → Pulse for Windows

日期：2026-09-23。目标：对齐 Javis603/token-monitor（MIT, 2282★）在 Windows 单机场景下
的全部适用功能，并保持我们的既有优势项。本文件是"他有的我都有"的验收清单，
每轮迭代后更新状态列。状态：✅已有 · 🔨进行中 · 📋已排期（有清单）· 🗓后续轮 · ⚖️需用户决策 · N/A 不适用

## 数据采集与统计

| # | Token Monitor 功能 | 我们的状态 | 备注/轮次 |
|---|---|---|---|
| 1 | 38+ 工具本地 Token 审计 | 🔨 7 来源（claude/codex/gemini/cline/roocode/kilocode/openclaw + 本轮 zcode） | Round 5 续扩：OpenCode/Qwen CLI/Kiro/Trae/CherryStudio/LM Studio |
| 2 | 24+ 供应商实时额度限制 | ✅ 领先：18+ 额度引擎（API 级，含 StepFun 扫码+无感续期） | 持续跟进新供应商限额窗口细分 |
| 3 | 会话级明细（每 prompt 拆分） | 🗓 无 | Round 5：从 events/转录按会话聚合 |
| 4 | 缓存命中统计（分项展示） | 🔨 后端有 cache_read/write 字段 | Round 4：前端分项展示 + 一致性守卫（DASHBOARD_PLAN 项目一） |
| 5 | 实时 token 速率 tok/s | 🗓 无 | Round 4：activity.rs 日志尾随 + 速率窗口 |
| 6 | 成本估算 | ✅ 内置主流模型单价库 | |
| 7 | 多币种成本（USD/CNY…） | 🗓 有 CNY 余额展示，成本仅 USD | Round 4：汇率换算 + 币种切换 |
| 8 | 自定义扫描路径 | 🗓 仅少量 env override | Round 5：每来源可配置附加目录 |
| 9 | WSL 用量合并 | 🗓 无 | Round 5（Windows 适用） |
| 10 | 已删除会话用量保留（日归档） | 🔨 本轮落地 daily_archive（max-upsert） | 工作流 dwfrun-0b481add |
| 11 | 趋势仪表盘（热力图/streak/K线/堆叠柱） | 📋 docs/DASHBOARD_METRICS_PLAN.md 项目二 | Round 3 |
| 12 | 活跃天数/连续天数/峰值单日 | 📋 同上 | Round 3 |
| 13 | 活跃时长（activeMs） | 📋 同上 项目三 | Round 3 |
| 14 | 数据导出 CSV/JSON | 🔨 本轮落地 export_ledger + 前端按钮 | 工作流 dwfrun-0b481add |
| 15 | 订阅记录（订阅价 vs 用量倍数） | 🗓 无 | Round 4 |
| 16 | 供应商状态页视图 | 🗓 无 | Round 5 低优先 |
| 17 | 账本分项一致性守卫 | 📋 DASHBOARD_METRICS_PLAN.md 项目一 | Round 3 |

## 多设备与分发

| # | Token Monitor 功能 | 我们的状态 | 备注/轮次 |
|---|---|---|---|
| 18 | 多设备实时同步（hub 三后端 + SSE） | ⚖️ 战略大工程 | Round 6+，与"单机零依赖"哲学需取舍 |
| 19 | iOS / macOS 小组件 | N/A | Windows 项目不适用 |
| 20 | Homebrew 分发 | N/A | winget 替代见 #22 |
| 21 | 代码签名安装包 | ⚖️ 付费项（Azure Trusted Signing） | SmartScreen 拦截是真实流失点 |
| 22 | winget/scoop 分发 | 🗓 无 | Round 5：提交 winget-pkgs manifest |
| 23 | 多语言界面（5 语） | 🗓 纯中文 | Round 5：先补 EN |

## 界面与体验

| # | Token Monitor 功能 | 我们的状态 | 备注/轮次 |
|---|---|---|---|
| 24 | Edge Dock 悬浮栏 + hover 卡片 | ✅ 领先：贝塞尔底座/微光折叠/0% 闪烁详情卡/多显示器 | 我们的核心形态 |
| 25 | 托盘 popover | ✅ 有托盘 | |
| 26 | Floating Bubble 模式 | ⚖️ 与自由浮动模式重叠 | 评估后可能 N/A |
| 27 | 菜单栏布局编排器 | ⚖️ 悬浮栏语义固定（每账号一环） | 低优先 |
| 28 | 浅色模式/主题/字体 | 🗓 暗色玻璃已有 | Round 5 可选 |
| 29 | 全局快捷键 | ✅ 有 | |
| 30 | 应用内更新中心 | ✅ 有，本轮强化 Atom 备用通道 | |
| 31 | Discord Rich Presence | 🗓 无 | Round 5 彩蛋（opt-in） |
| 32 | 多账号同供应商 | ✅ 有 | |
| 33 | Codex 账号一键切换 | 🗓 无 | Round 5 评估 |
| 34 | Codex reset 预测 | ✅ 领先：全供应商燃烧率预测 | Banked 细分评估 |
| 35 | 动画机器人 BotMark | ✅ 领先（上游移植） | 对方无此功能 |

## 轮次规划

- **Round 2（进行中，dwfrun-0b481add）**：#10 日归档、#14 导出、#1 的 zcode、README 能力矩阵、公开文档清理
- **Round 3（已排期）**：#17 一致性守卫 → #13 活跃时长 → #11/#12 仪表盘（见 DASHBOARD_METRICS_PLAN.md）
- **Round 4**：#4 缓存分项展示、#5 tok/s、#7 多币种、#15 订阅记录
- **Round 5**：#1 续扩来源、#3 会话明细、#8 自定义扫描路径、#9 WSL、#16 状态页、#22 winget、#23 EN、#28 浅色、#33/#34 评估
- **Round 6+（需决策）**：#18 多设备同步、#21 代码签名、#26/#27 评估、#31
- **完成判据**：Round 5 结束时，除 ⚖️ 决策项与 N/A 外全部 ✅，即达成"他有的我都有"。
