# 下一轮开发清单：趋势仪表盘三件套（对标 Token Monitor）

日期：2026-09-23。前置状态：v0.6.6 已发布；本轮（工作流 dwfrun-0b481add）正在落地
daily_archive 日聚合归档、ZCode 统计来源、CSV/JSON 导出、README 能力矩阵。
**本清单的项目二依赖本轮 daily_archive 表落地**，项目一、三相互独立。

参照项目：Javis603/token-monitor（MIT，2282 星）。其统计管线 =
tokscale CLI 产出「贡献图」（每日 × 每工具 × 每模型的 tokens/cost/messages/activeTimeMs）
→ 每日本地归档（本地午夜切天，370 天滚动窗）→ 纯函数算指标。关键源码位置（供交叉阅读）：

- `src/shared/history.js`：`parseGraphResult`（分项一致性守卫）、`computeStreaks`、
  `computeIntensities`（热力图 5 档分桶）、`monthlyRollup`、`activeTimeTotal`
- `src/shared/dailyHistoryArchive.js`：`normalizeObservation`/`addObservation`（归档累加与恢复比对）
- `src/electron/renderer/usageCharts.js`：`candleChart`（K 线 = 日序列按 bucketDays 分桶取 OHLC）

---

## 项目一：账本分项一致性守卫（防双计/防格式漂移）

**目标**：events 分项（input/output/cache_read/cache_write）出现语义矛盾时，
该事件标记 partial 并计数透出，而不是静默计入趋势数字。保证仪表盘与导出数据可信。

**现状**（src-tauri/src/ledger.rs）：`parse()` 各来源分支直接 `count()` 取值入 Event，
无任何分项一致性校验；`Summary.notes` 已有警告通道，`Row.partial` 已存在但语义松散。

**设计**：
1. 为每个来源定义显式守卫规则（解析生成 Event 时执行，违规 → `partial=true` 并使
   Summary 的异常计数 +1，写入 notes）：
   - claude/zcode：四个分项均 ≥0；`input_tokens` 缺失但 usage 对象存在 → partial（现状已有，
     保持并纳入计数）；
   - codex：现有 totals 回退检测（reset）之外，补「delta 分量矛盾」——
     `cached_input_tokens` 的增量 > `input_tokens` 增量时标 partial；
   - gemini/cline/roocode/kilocode/openclaw：分项负值（saturating 后变为异常大值）检测、
     `cache_read + cache_write > input + cache_read + cache_write` 类来源内矛盾检测；
   - 总量守卫（对齐全家桶语义后逐源定义，不搞全局一刀切）。
2. Summary 增加 `anomalies: u64`（或并入 notes 文案），异常事件计数透出到前端状态区。
3. **不改 Row 结构、不加字段**，避免波及前端与导出 CSV 列。

**验收**：每来源一个"矛盾 fixture"单测（正常事件不受影响、矛盾事件被标记且计数正确）；
现有全部门禁不回归。

**改动文件**：`src-tauri/src/ledger.rs`（parse 分支 + Summary + 测试）。工作量 ≈ 0.5 天。

---

## 项目二：趋势仪表盘指标模块（活跃天数/连续天数/峰值单日/热力图/K 线）

**目标**：在 daily_archive 之上提供跨年趋势视图——Token Monitor 最抓眼球的界面，
我们目前完全没有对应物（TokenSpend 只有窗口内聚合）。

**依赖**：本轮工作流的 `daily_archive(day,source,model,...)` 表（max-upsert 语义）。

**设计**：
1. 后端（ledger.rs）：
   - `pub struct DailyTrend { day: String, tokens: u64, per_source: BTreeMap<String,u64> }`
     （tokens 口径 = input+output+cache_read+cache_write 全口径，与归档列一致）；
   - `pub fn daily_trends(db_path:&Path, cap_days:u32 /*默认 370*/) -> Result<Vec<DailyTrend>,String>`：
     以 daily_archive 为主数据源按 day 升序输出，当日若 events 重算值更大则取重算值
     （与归档 max 语义一致），缺失 source 补 0；**本地午夜切天**（与归档口径一致，禁止 UTC；
     归档 day 键的时区偏移在首次归档时冻结于 ledger 库 meta 表 `archive_tz_offset_secs`，
     系统时区变更不重切——max-upsert 无删除路径，随当前时区重切会让同一批消耗永久落在两个 day 键下）；
   - 纯函数指标（充分单测，重点边界：今天不活跃 → current_streak=0；跨月连续段；
     空数据）：`active_days`（tokens>0 天数）、`current_streak`/`longest_streak`
     （对齐 token-monitor `computeStreaks`：从今天回走 / 排序扫连续段）、`peak_day`+`peak_tokens`；
   - 新 Tauri 命令 `trend_metrics()`（commands.rs + lib.rs 注册）一次返回
     `{days, active_days, current_streak, longest_streak, peak_day, peak_tokens}`。
2. 前端：
   - TokenSpend 页新增「趋势」tab（或独立窗口，遵循现有窗口创建模式）：
     - **热力图**：贡献格按 tokens 相对窗口最大值 5 档着色（`computeIntensities` 同款分桶：
       ≥75%→4、≥50%→3、≥25%→2、>0→1），GitHub 风格网格，悬浮显示日期与数值；
     - **K 线**：日序列按 7 天一桶从最新往回分桶，open/close/high/low/up
       （对齐 `usageCharts.js candleChart`），SVG 自绘可参考现有 HourlyUsageChart 的实现模式；
     - **指标卡**：活跃天数 / 连续天数（当前+最长）/ 峰值单日 / 总量。
   - 悬浮数值格式化复用现有紧凑格式（K/M/B）。
3. 导出：trend 数据纳入项目已落地的导出通道（JSON），CSV 不强制。

**验收**：指标纯函数单测（构造 30~40 天序列验证 streak 边界、峰值、月界）；
前端组件测试覆盖热力图分桶与 K 线分桶；门禁全过。

**改动文件**：`src-tauri/src/ledger.rs`、`commands.rs`、`lib.rs`、
`src/pages/TokenSpend.tsx`（或新组件 `src/components/TrendDashboard.tsx`）。工作量 ≈ 2~3 天。

---

## 项目三：每日活跃时长（activeMs）

**目标**：支撑「活跃时间」指标卡（对齐截图中的 64h 50m），数据来自我们已有的
events 精确时间戳，不依赖外部工具。

**设计**：
1. 口径（保守、可解释）：
   - 同一 source 内按 ts 升序，相邻事件间隔 **≤5 分钟** 视为同一活动段；
   - 每段时长 = Σ min(相邻间隔, 5min)（长会话跨小时不膨胀）；
   - 跨 source 不合并、不去重（同时开多个工具按并行累计，页面文案注明口径）。
2. 存储：新表 `daily_active(day TEXT PRIMARY KEY, seconds INTEGER)`，
   扫描入 events 后顺手重算当日并 **max-upsert**（与 daily_archive 同语义，防回退）。
3. 展示：项目二的指标卡「活跃时间」（mm 后 hh:mm 格式）；无独立界面。

**验收**：单测覆盖——密集事件（同段）、稀疏事件（>5min 切段）、跨天边界（段计入起始日）、
空数据；门禁全过。

**改动文件**：`src-tauri/src/ledger.rs`（表 + 计算 + 测试）。工作量 ≈ 0.5~1 天。

---

## 实施顺序与里程碑

1. **项目一**（数据可信是二的前提）→ 2. **项目三**（给二供数据）→ 3. **项目二**（界面收口）。
   三项合计 ≈ 3~4 天工作量，随下一版本发布（建议 **v0.7.0**：含仪表盘功能增量）。
   上一轮遗留的人工验收项一并带上：导出按钮端到端点按、ZCode 真实大数据量解析性能观察
   （当前机器 zcode 占比 92.9%，正好是真实压测样本）。
