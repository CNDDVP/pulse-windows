# Round 5a 开发清单：审计来源扩展（ZCode 信封/OpenCode/Qwen）+ 自定义扫描路径

日期：2026-09-23。前置：Round 2/3/4 已落地（f31aef5、07fd1fc、5c3e647）。对应对齐审计
#1（来源续扩）与 #8（自定义扫描路径）。参照 token-monitor 的数据路径文档（其 README 供应商表）。

## 项目一：ZCode CLI 信封格式来源（用户主力来源，优先）

**背景**（Round 2 升级探查结论）：本机 ~/.zcode 下除已接入的 claude 格式转录外，还有
172 个 ZCode 自有信封 jsonl：`~/.zcode/cli/agents/**/transcript.jsonl` 与
`~/.zcode/cli/rollout/*.jsonl`，事件形如 model_streaming / model_complete / turn_started，
usage 为驼峰（inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）。
另可能存在 `~/.zcode/cli/db/db.sqlite`（存在性与表结构待只读探查）。

**设计**：
1. **先探查再实现**：只读抽 2~3 个真实信封文件，确认 (a) usage 在哪类事件里；
   (b) 数值是逐条增量还是会话累计（累计则需 codex 式 delta 逻辑：totals 回退=重置）；
   (c) cli/db/db.sqlite 是否存在及表结构——若为现成聚合库且可信，读库优于解析 jsonl。
2. parse() 新增 zcode 信封分支（source 仍用 "zcode"，同一工具统一口径）；驼峰字段映射；
   累计值走 delta；无 usage 的事件跳过。
3. **防双计（关键）**：探查 v2 claude 格式转录与 cli 信封是否为同一会话的两份记录
   （比对会话 id / 时间戳重叠）。若重叠：选定单一权威根（数据更全者），另一根不再收集；
   若不重叠：两根并存。结论与证据写进代码注释。
4. sources_with_cancel 增加对应根；discover 过滤规则对齐（信封文件名模式）。

**验收**：合成信封 fixture 单测（增量/累计两式都测）；若本机有真实数据，扫描后
Summary 的 zcode 行数值应显著增长（人工验收项）。

## 项目二：OpenCode 来源

路径（token-monitor 文档）：`~/.local/share/opencode/`（`opencode*.db` SQLite 与
`storage/message/`）。优先解析 `storage/message/` 下的 JSON/JSONL（避免 SQLite schema
耦合）；若本机无此目录则合成 fixture 实现并标注"未经真实数据验证"。XDG_DATA_HOME 覆盖。

## 项目三：Qwen CLI 来源

路径：`~/.qwen/projects/**/*.jsonl`（Claude Code 同构布局，大概率可复用 claude 分支）。
先只读抽样确认格式；QWEN_CONFIG_DIR 环境变量覆盖。同根布局复用=低成本高确定性。

## 项目四：自定义扫描路径

**设计**：设置新增 `token_spend_extra_paths: Record<source, string[]>`（每来源附加目录，
上限每来源 20 条）；ledger 扫描时把这些目录按对应 source 一并 collect（复用 scan_paths
机制）；设置持久化与读写命令沿用订阅记录模式。TokenSpend 页「订阅记录」旁新增折叠面板
「扫描路径」：按来源增删目录（绝对路径校验、存在性提示不阻断）。**诚实标注**：自定义路径
里的文件与默认路径同样参与去重（按路径），跨目录复制同一文件会双计——面板注明。

**验收**：临时目录 + 合成文件的单测（附加路径被扫描、非法路径被忽略不崩）；前端面板测试。

## 门禁与复核

cargo test --lib、vitest/typecheck/lint 全过；复核员三名（后端/前端/双计与诚实性专查——
重点查新来源的双计风险与"未经真实数据验证"标注）；逐发现独立确认；预计 ≈ 3 天。
