# Round 5b 开发清单：会话级明细、WSL 用量、供应商状态页

日期：2026-09-23。前置：Round 2/3/4/5a 已落地（f31aef5、07fd1fc、5c3e647、9bd2b2b）。
对应对齐审计 #3（会话明细）、#9（WSL）、#16（状态页）。

## 项目一：会话级明细（Session Drill-down）

**目标**：Token Monitor 的"打开单个会话看每次调用的 token 拆分"。我们的"会话" =
一个转录文件（claude/zcode/qwen 的 .jsonl、codex 的 session 文件等）；ZCode CLI 库投影
按其 session 键聚合。

**设计**：
1. 后端：新命令 `token_spend_sessions(source: Option<String>, offset: u32, limit: u32)`
   → `Vec<SessionRow>`：按 events.path 聚合（source、文件名尾段做标题、首末 ts、
   总 tokens 四分项、估算成本、event 数），按末次活动倒序 + 分页（每页 50）；
   `token_spend_session_detail(path: String)` → 该文件内逐事件列表
   （ts/model/input/output/cache_read/cache_write），上限 500 条（标注截断）。
   ZCode CLI 库来源：path 为 db.sqlite 时以其 session 键为会话（若投影含 session 维度），
   否则该来源显示"按 CLI 库整体聚合，无会话拆分"（诚实标注）。
2. 前端：TokenSpend 新「会话」tab：来源筛选 + 列表（标题/来源/时间/模型数/tokens/成本），
   行展开加载明细（懒加载，展开时才 invoke detail）。会话标题用文件名尾段
   （如 `<uuid>.jsonl` 截短），不读取转录正文内容（隐私边界不变：不展示 prompt 文本）。
3. 测试：聚合与分页单测；明细上限截断单测；前端组件测试（列表渲染/懒加载/来源筛选）。

**改动**：ledger.rs、commands.rs、lib.rs、TokenSpend.tsx、新组件 SessionList.tsx。≈1.5 天。

## 项目二：WSL 用量（opt-in，默认关）

**目标**：Windows 侧合并读取 WSL 发行版内的文件型来源（claude/qwen/zcode-claude 转录）。

**设计**：
1. 设置开关 `token_spend_wsl: bool`（默认 false，通用设置页开关 + 说明文案）。
2. 开启后扫描：`wsl.exe -e sh -c 'cat <path>'` 逐文件读取 WSL 内
   `~/.claude/projects`、`~/.qwen/projects`（先 `wsl.exe -e sh -c 'echo $HOME'` 定位），
   复用现有 parse 分支；文件路径键加 `wsl:` 前缀与 Windows 侧天然去重（不同 path_key）。
   **同会话双计风险**：WSL 与 Windows 若挂载同一目录会被两次收集——事件 id 稳定来源
   按 (source,event_id) 折叠（Round 5a 已验证该机制），文档注明。
3. 预算与诚实降级：WSL 来源独立文件数预算（2000）；wsl.exe 不存在/超时/发行版无数据
   → 静默跳过并在 notes 标注"WSL：未检测到可用发行版/读取失败"；单文件读取超 256KB
   沿用 large 跳过。**不做** SQLite 类来源（OpenCode 等）的 WSL 读取（需 headless agent，
   复杂度不成比例，README 注明）。
4. 测试：命令注入防护（路径含引号/分号的 fixture 必须被安全转义或拒绝）——**安全关键**；
   读取失败降级单测。

**改动**：ledger.rs（wsl 读取器）、types.rs（设置）、GeneralPage.tsx（开关）、README。≈1.5 天。

## 项目三：供应商状态页

**目标**：设置/TokenSpend 内一键查看主流供应商服务状态（对齐 Token Monitor Status view）。

**设计**：
1. 数据源（官方公开端点，走应用既有代理设置）：
   Anthropic `https://status.anthropic.com/api/v2/status.json`、
   OpenAI `https://status.openai.com/api/v2/status.json`（同为 Statuspage 系）、
   StepFun/智谱无公开 status API → 不做，界面注明"该供应商无公开状态端点"（诚实）。
2. 后端命令 `fetch_provider_status()`：并发拉取（10s 预算），返回
   `{provider, indicator, description, updated_at}`；失败该供应商标 unavailable，不阻塞其他。
3. 前端：TokenSpend 页「状态」区块（或设置关于页）：手动刷新按钮 + 指示灯
   （绿=operational/黄=degraded/红=outage/灰=unknown）+ 更新时间。不做自动轮询（避免常驻流量）。
4. 测试：响应解析 fixture 单测（含非 200/畸形 JSON 降级）。

**改动**：commands.rs、lib.rs、新组件 ProviderStatus.tsx。≈0.5~1 天。

## 门禁与复核

cargo test --lib、vitest/typecheck/lint 全过；复核三名（后端/前端/**安全专查**——
WSL 命令构造的注入面与隐私边界：不得读取或展示转录正文）+ 逐发现确认。预计 ≈ 3 天。
