# Round 5d 开发清单（收官轮）：浅色模式、Discord RPC、Kiro/CherryStudio 来源

日期：2026-09-23。前置：Round 2~5c 已落地（最新 f811f59）。对应对齐审计 #28/#31/#1 续扩。

## 项目一：浅色模式（主题系统重构）

**设计**：
1. 先做色彩令牌化：把全部组件的内联颜色类（zinc-900/60、bg-emerald-700 等硬编码）
   收敛为语义 CSS 变量（--surface、--surface-2、--border、--text-1/2/3、--accent、--ok、
   --warn、--danger），index.css 定义 :root（dark 默认）与 [data-theme="light"] 两套映射；
   组件改用 var() 引用（Tailwind arbitrary values 或 style）。
2. 通用设置页新增「主题」选择（深色/浅色），走既有设置通道；document.documentElement
   dataset.theme 同步；悬浮栏/详情卡/设置窗/托盘菜单全部随主题。
3. 诚实边界：BotMark 动画的身体色策略（深色身体配浅色眼）跟随主题对比度规则自适应；
   供应商品牌色不变。
4. 验收：两套主题下全部页面可读（复核员做对比度抽查）；grep 无残留硬编码色值
   （品牌色/语义色白名单除外，白名单在评审 ask 中列出）；现有测试全过。

**改动**：index.css、全部组件（令牌替换）、设置。工作量 ≈ 2 天（最大项）。

## 项目二：Discord Rich Presence（opt-in，默认关）

**设计**：
1. 通用设置页开关「Discord 状态广播」（默认关）+ 说明文案（本机与 Discord 通信）。
2. Rust 侧引入维护中的 rich-presence crate（允许新增依赖，锁定版本）；仅在开关开启且
   Discord 运行时连接，广播：活动状态（working/idle，复用活动灯信号）、当前账号数、
   今日 token 总量（读 ledger 当日聚合）；每 60s 节流更新；连接失败静默。
3. 隐私：不广播账号名/供应商名明细，只广播聚合数字与"正在写代码"状态（诚实标注文案）。
4. 测试：payload 构造纯函数单测；开关关闭时零网络行为单测。

**改动**：Cargo.toml、新模块 discord_presence.rs、设置、GeneralPage。≈0.5~1 天。

## 项目三：Kiro / CherryStudio 来源

- **Kiro**：`~/.kiro/sessions/cli/`、VS Code globalStorage（Kiro IDE）与 kiro-cli DB
  （token-monitor 文档路径）。JSONL 优先，SQLite 次之——实测 kiro-cli SQLite/globalStorage
  仅含估计值（上下文窗口×百分比、字符数÷4），按『缺失不造假』原则不读取、不折算，
  以 .json 会话头计数器为准；KIRO_CONFIG_DIR 覆盖。
- **CherryStudio**：`<app-data>/CherryStudio/Data/Agents/.claude/projects/`（V2）与
  `.claude/projects/`（legacy）——Claude 同构转录，复用现有分支；app-data 用
  dirs::data_dir() 平台规则。
- 两来源均：只读抽样真实数据（本机若有）→ 合成 fixture 测试 → README 矩阵行 +
  诚实标注（未经真实数据验证时显式写明）。预计 ≈ 1 天。

## 门禁与复核

cargo test --lib、vitest/typecheck/lint 全过；复核三名（主题一致性专查——对比度与
残留硬编码色值 grep/后端/前端）+ 逐发现确认。预计 ≈ 3~4 天。完成后 Round 5 系列收官，
除两项决策项（多设备同步、代码签名）外全部对齐。
