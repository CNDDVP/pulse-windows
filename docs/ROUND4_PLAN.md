# Round 4 开发清单：实时速率、多币种、订阅记录、缓存分项

日期：2026-09-23。前置：Round 2/3 已落地（daily_archive/daily_active/trend_metrics/TrendDashboard/
export_ledger/export_trend，提交 f31aef5、07fd1fc）。对齐审计见 docs/FEATURE_PARITY_AUDIT.md
（本轮对应 #4/#5/#7/#15）。

## 项目一：实时 Token 速率（tok/min）

**目标**：悬浮栏详情卡显示该账号"当前生成速率"，对齐 Token Monitor 的 live token rate。

**设计**：
1. 数据源：src-tauri/src/activity.rs 已为活动灯逐行尾随各渠道日志。在其中提取
   usage 字段（Claude: message.usage.output_tokens；Codex: token_count 信息）——
   注意活动灯语义不要被改变（token 计数不作为工作信号，只旁路采集）。
2. 计算：每账号维护滑动窗口（60 秒）内的 output token 增量，速率 = 窗口增量 / 窗口秒数，
   输出单位 tok/min（数值 >=1 才显示，否则"—"）。
3. 透出：随现有活动事件（或新事件 activity-rate）emit；前端详情卡
   （UsageDetailCard）账号行下新增"速率"行，仅工作状态显示；渠道日志无 usage
   字段的渠道显示"—"，不编造。
4. 测试：速率窗口计算的纯函数单测（增量/回退/窗口滑出）。

**改动**：activity.rs、详情卡组件、类型。工作量 ≈ 1 天。

## 项目二：多币种成本显示（USD/CNY）

**目标**：Token Spend 与详情卡的成本估算支持按设置币种显示。

**设计**：
1. 汇率策略（诚实优先）：设置页新增"成本显示币种"（USD/CNY）与"USD→CNY 汇率"
   （默认 7.2，可手改，纯本地设置，无联网取汇）；所有换算处标注
   "按固定汇率 X.XX 估算"。不做自动汇率拉取（避免隐性网络依赖）。
2. 换算只发生在展示层：后端成本估算保持 USD 原值入库/导出（导出文件加
   display_currency 字段注明）；前端在渲染处统一换算（新建
   src/lib/currency.ts 纯函数 + 单测）。
3. 设置存储走既有设置通道；设置页（通用页）加两控件。

**改动**：src/lib/currency.ts（新）、TokenSpend.tsx、GeneralPage.tsx、设置类型。
工作量 ≈ 0.5~1 天。

## 项目三：订阅记录（订阅价 vs 用量倍数）

**目标**：手动记录每个账号的订阅成本，展示"本月用量是订阅价的几倍"。

**设计**：
1. 数据：按来源（source key：claude/codex/gemini/cline/roocode/kilocode/openclaw/zcode）
   记录 {price, currency, cycle_days, start_date, note}，存设置（跟随既有设置持久化）。
2. UI：TokenSpend 页顶部折叠面板「订阅记录」：每来源一行，可编辑价格/周期；
   展示列 = 订阅价、本月已用量成本（取自现有按来源成本聚合）、倍数
   （=本月成本/订阅价，>=1 时橙色强调）。无该来源用量数据显示"—"。
3. 口径诚实：倍数基于估算成本（公开定价），页面已有"仅供参考"文案复用；
   API 额度类供应商（不在本地审计的）不提供订阅记录入口。
4. 导出：订阅记录随 export_ledger JSON 一并输出（subscriptions 数组）。

**改动**：设置结构、TokenSpend.tsx（面板）、commands（如需新命令）、导出。
工作量 ≈ 1 天。

## 项目四：缓存分项展示与命中率

**目标**：Token Spend 模型明细中展示缓存读写与命中率（数据已在 ledger，缺展示）。

**设计**：
1. 「按来源 / 模型」分组视图：每模型行展开显示
   input / output / cache_read / cache_write 四分项与
   缓存命中率 = cache_read / (input + cache_read + output)（分母 0 时不显示）。
2. 汇总行同步展示全窗口命中率。
3. 纯展示层，ledger 不改；分项一致性由 Round 3 守卫保证。

**改动**：TokenSpend.tsx（分组明细）、纯函数 + 单测。工作量 ≈ 0.5 天。

## 实施顺序与门禁

后端先行（项目一数据层、项目三存储），前端随后（项目二/三/四 UI），同一工程师
串行避免同文件冲突。门禁：cargo test --lib、npm run test/typecheck/lint 全过；
三名独立复核员（后端/前端/诚实性——专查口径标注与"—"降级是否诚实）+ 逐发现确认。
预计 ≈ 3 天，随 v0.7.0 发布。
