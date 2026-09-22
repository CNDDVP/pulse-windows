# 功能对齐审计：Token Monitor → Pulse for Windows

日期：2026-09-23。目标：对齐 Javis603/token-monitor（MIT, 2282★）在 Windows 单机场景下
的全部适用功能，并保持我们的既有优势项。本文件是"他有的我都有"的验收清单，
每轮迭代后更新状态列。状态：✅已有 · 🔨进行中 · 📋已排期（有清单）· 🗓后续轮 · ⚖️需用户决策 · N/A 不适用

## 数据采集与统计

| # | Token Monitor 功能 | 我们的状态 | 备注/轮次 |
|---|---|---|---|
| 1 | 38+ 工具本地 Token 审计 | ✅ Round 5a：11 来源（+ZCode 信封与 CLI 库、OpenCode、Qwen CLI）；Kiro/Trae/CherryStudio 等按需继续 | 本机主力 ZCode 全链路已覆盖 |
| 2 | 24+ 供应商实时额度限制 | ✅ 领先：18+ 额度引擎（API 级，含 StepFun 扫码+无感续期） | 持续跟进新供应商限额窗口细分 |
| 3 | 会话级明细（每 prompt 拆分） | ✅ Round 5b：会话 tab（按转录文件/CLI session 聚合 + 懒加载逐事件，不读正文） | 每行级 prompt 拆分按需评估 |
| 4 | 缓存命中统计（分项展示） | ✅ Round 4：模型明细四分项 + 命中率展示；守卫 Round 3 已落 | |
| 5 | 实时 token 速率 tok/s | ✅ Round 4：tok/min（活动灯旁路采集、60 秒窗口、详情卡速率行） | |
| 6 | 成本估算 | ✅ 内置主流模型单价库 | |
| 7 | 多币种成本（USD/CNY…） | ✅ Round 4：CNY/USD 展示层换算（固定汇率可改，诚实标注） | |
| 8 | 自定义扫描路径 | ✅ Round 5a：每来源附加目录（设置面板 + 校验 + 按源去重口径披露） | |
| 9 | WSL 用量合并 | ✅ Round 5b：opt-in 文件型来源合并（命令注入防护、诚实降级） | SQLite 类来源按 Token Monitor 同款口径不做 |
| 10 | 已删除会话用量保留（日归档） | 🔨 本轮落地 daily_archive（max-upsert） | 工作流 dwfrun-0b481add |
| 11 | 趋势仪表盘（热力图/streak/K线/堆叠柱） | ✅ Round 3：TrendDashboard（趋势 tab，370 天窗口） | |
| 12 | 活跃天数/连续天数/峰值单日 | ✅ Round 3：trend_metrics 指标卡 | |
| 13 | 活跃时长（activeMs） | ✅ Round 3：daily_active 表 + 指标卡（跨来源不去重口径已标注） | |
| 14 | 数据导出 CSV/JSON | ✅ Round 2/3：export_ledger + export_trend | |
| 15 | 订阅记录（订阅价 vs 用量倍数） | ✅ Round 4：订阅面板 + 倍数（≥1 橙色提醒）+ 随导出输出 | |
| 16 | 供应商状态页视图 | ✅ Round 5b：Anthropic/OpenAI 官方端点 + 四色指示灯（无端点供应商诚实标注） | |
| 17 | 账本分项一致性守卫 | ✅ Round 3：按来源守卫规则 + Summary 异常计数 | |

## 多设备与分发

| # | Token Monitor 功能 | 我们的状态 | 备注/轮次 |
|---|---|---|---|
| 18 | 多设备实时同步（hub 三后端 + SSE） | ⚖️ 战略大工程 | Round 6+，与"单机零依赖"哲学需取舍 |
| 19 | iOS / macOS 小组件 | N/A | Windows 项目不适用 |
| 20 | Homebrew 分发 | N/A | winget 替代见 #22 |
| 21 | 代码签名安装包 | ⚖️ 付费项（Azure Trusted Signing） | SmartScreen 拦截是真实流失点 |
| 22 | winget/scoop 分发 | ✅ Round 5c：manifest 生成器 + 提交文档（实际 PR 需用户在微软仓执行） | |
| 23 | 多语言界面（5 语） | ✅ Round 5c：中/英双语（自研 i18n 框架 + 语言设置；后端消息暂中文已标注） | 繁/日/韩按需 |

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
