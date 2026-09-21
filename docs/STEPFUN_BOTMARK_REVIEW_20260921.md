# StepFun 双模式与 BotMark 施工审查

> 后续修复已执行：见 [修复交付记录](STEPFUN_BOTMARK_FIXES_20260921.md)。以下保留修复前证据，“未修复”状态仅描述审查当时，不代表最新代码。

审查日期：2026-09-21。基线 HEAD：2aa653098c076a747331d3097f6f983bef8fff57，加当前未提交的两批施工。package.json 为 0.6.0，Rust/Tauri 仍为 0.5.2。施工报告仅作线索，以下以当前代码为准。未修改业务代码、真实配置或凭据，未调用真实账号接口。本次不是全部动画几何与所有平台组合的验收。

## 用户截图结论

Credit 与人民币余额是两个不同指标。现有详情卡遍历所有 balances，并非只取第一项；若后端同时返回 CNY 和 Credit，两项都会显示。截图来源明确是“网页 Token → 控制台接口”，与当前仅保存网页凭据的情况一致，但未读取真实凭据，不能断言用户当前 Credential Manager 的内容。

已确认保存路径存在覆盖缺陷：先保存 API Key，再单独补填或更新网页 Token，会将 API Key 覆盖掉。这是截图缺少现金余额的高度匹配解释。若两项同时保存仍缺少现金，也可能是 API 请求失败被静默忽略。不能直接把 Credit 数字改标为人民币，更不能硬编码截图中的 15 元。

正确呈现：API 可用余额 ¥15.00（接口实时值）；套餐剩余 15.88 亿 Credit；套餐已用 0.75%；分别标注来源、更新时间与失败状态。API 未配置时明确“未配置 API Key，无法查询人民币余额”。

## 问题清单

### S01 / P1：更新一种凭据会删除另一种

- 位置：src/pages/SettingsWindow.tsx:264、301、364；src-tauri/src/commands.rs:225。
- 根因：三个保存入口都只序列化本次非空输入，然后调用整条替换的 set_credential。保存后双输入框清空，下一次单独更新 Token 自然不携带已有 Key。
- 修复：后端提供双字段补丁接口，明确 Keep/Set/Delete 三种操作；读取旧值、合并、写入及失败回滚都在后端完成。前端只返回两个 configured 标记，不回传 Secret。全部保存入口共用同一路径。
- 验收：先 Key 后 Token、先 Token 后 Key、单独轮换、单独删除、保存失败，均不意外删除另一字段。

### S02 / P1：双来源部分失败被丢失，可能把不完整数据当正常

- 位置：src-tauri/src/providers/stepfun.rs 的 Merge results。
- 网页成功、API 失败时 account_err 被丢弃；API 成功、网页失败时，不论网络错误、服务端错误或响应格式错误，一律提示 Token 过期。source_label 描述配置而非实际成功来源。
- 修复：API 与 Plan 分别存 result/state/error/checked_at/last_success_at，再形成部分成功视图；保留真实错误类型，缓存只复用对应来源且标为旧数据。HTTP 200 还需验证业务状态和可识别数据。
- 验收：两者成功、任一 401/403/429/5xx、超时、200 业务错误、空 JSON、两者失败均有准确反馈，不将未获得的现金余额标为已获取。

### S03 / P2：成功额度仍残留“服务未报告可识别的额度数据”

- 位置：src-tauri/src/types.rs:36；src-tauri/src/providers/parsers.rs StepFun 分支末尾。
- reading(id, vec![]) 初始化时已携带 no_data 错误。后续改为 live 并清 error_code，却仅在 error_message 本来为空时才清消息，因此默认错误永远残留。截图黄色提示符合这条确定调用链。
- 修复：成功后显式替换错误消息，只保留实际部分失败告警，最好把 warning 与 error 分开建模。
- 验收：有效现金、有效 Credit、双有效均无虚假 no_data；部分失败仍展示正确告警。

### S04 / P2：套餐字符串时间戳被丢弃，周期被硬编码为 30 天

- 位置：parsers.rs 的 subscription_credit_reset_time.as_i64() 与 Some(30 * 86400)。
- 5h/weekly 接受数字字符串，但 Credit 重置不接受，导致同类返回在套餐路径显示“未报告重置时间”。截图缺少倒计时与此缺陷相符，具体响应类型尚未核实。
- 仅凭下一次重置时间不能证明周期恰好 30 天，错误周期会污染时间环与耗尽预测。
- 修复：复用 date() 处理秒/毫秒和数字字符串；周期来源不明时保持 null，仅显示可靠的倒计时。不要把过期时间等同重置。
- 验收：整数、字符串、毫秒、null、0、已过期时间；不同账期不产生虚构进度/预测。

### S05 / P2：Credit 为零时余额条目消失，套餐与充值额度口径不一致

- 位置：parsers.rs，total_residual > 0 才 push；百分比只用 subscription_credit_left_rate。
- 有明确桶且剩余合计为 0，应显示 0 Credit。当前把零余额当不存在。余额汇总所有桶而百分比只计算订阅，若存在 top-up，二者口径不同却没有说明。未处理过期桶，是否会收到过期桶需样本验证。
- 修复：区分没有有效字段与有效零；订阅/充值/总量分别定义，按桶类型和有效期统计；不要用总 Credit 冒充现金。不支持的比例不要猜测或强行拼合。
- 验收：零额度、只有充值、订阅加充值、桶缺字段、过期桶、非法比例。

### S06 / P2：plan_family=2 被硬编码成 Plus Plan

- 位置：parsers.rs 的 plan_name fallback。
- 当前没有 GetStepPlanStatus 请求，不能称为“精确识别”真实订阅名。参考实现将 family=2 作为 Credit 类型，并从独立 subscription.name 获取套餐名。
- 修复：查询套餐状态或显示中性的“Credit 套餐”；命名请求失败不阻断额度。
- 验收：不同 Credit 套餐、未知 family、套餐名请求失败。

### S07 / P2：现金余额缺失时，使用累计充值/赠送金额伪造可用余额

- 位置：parsers.rs 的 cash/voucher fallback。
- 官方文档将 balance 定义为可用余额，total_cash_balance/total_voucher_balance 定义为总充值/总赠送；示例甚至 balance=0 而 total_voucher_balance=26，不能等价。
- 修复：缺 balance 时标注可用余额未知；累计字段仅独立展示，不加总替代可用余额。
- 验收：balance=0 保留零；缺 balance 但有累计值不得生成可用 CNY。

### S08 / P2：纯余额模式意外关闭独立的第二内环和时间外环

- 位置：src/components/UsageRing.tsx:20–50；SettingsWindow.tsx:911。
- primary_percent 被设为 null 后 valid=false；sec 和 timed 都以 valid 为门槛。因此不仅隐藏主百分比环，还把原本独立选择的辅助环一起关闭。设置说明仅承诺隐藏主百分比环。
- 修复：主环、内环、时间环独立判断数据有效性；明确“仅主环余额”与“全部额度环关闭”的产品含义。余额指标增加可选 CNY/Credit 来源，金额与 Credit 标签分开。
- 验收：主环纯余额时，已选且有效的第二内环/时间环保留；用户明确关闭才隐藏。

### S09 / P2：实现并非报告所称并发，并丢失限流信息

- 位置：stepfun.rs，先 await 网页完整请求，再 await API 请求；额外 404 fallback。
- 共享客户端每请求超时 12 秒，调度外层 25 秒；增加 fallback 后可能触发总超时。429 被归为 server，未保留 Retry-After；fallback 的错误统一变成 not_found。
- 修复：独立请求并发，受共同截止时间约束；复用统一错误分类和限流策略。未经验证的 fallback 不作为标准路径。
- 验收：一方慢响应不阻塞另一方结果至总超时；429 和 fallback 401 不被错标。

### B01 / P2：切换主额度可误触机器人“额度重置庆祝”【离线已复现】

- 位置：src/components/botEvents.ts:34；UsageRing.tsx:44。
- 使用 windows[0].id 判断“同窗口”，却拿 primary_percent 比较；primary_percent 可来自另一个被选中的窗口。实际所有额度不变，仅切换主额度 85→20，便触发 limitReset。
- 修复：比较同一个稳定 window_id 的实际值，并核实 reset 周期推进；选择变化、凭据变化、缓存切换不触发庆祝。优先复用已有后端重置判定证据，而非单靠跌幅。
- 验收：切换主窗口不庆祝，真实重置只庆祝一次，补充缓存/失败/账号切换用例。

### B02 / P2：动画重订阅时可能留下上一帧粒子或徽章【静态确定路径，待实机复验】

- 位置：BotMark.tsx 动画 useEffect 的 shapeLast/backLast/frontLast/badgeOn 局部状态；依赖 bodyColor/eyeColor。
- 更换颜色/主题触发重订阅，游标重新归零但 DOM 池仍保留旧状态。新帧若没有旧粒子/徽章，清理逻辑不知道旧槽位曾被占用，残留可能持续到以后重新使用槽位。
- 修复：effect 起始/cleanup 全量归一化池和徽章，或用持久 ref 维护实际 DOM 状态；防止颜色变更破坏清理逻辑。
- 验收：有粒子/徽章时切主题、机器人颜色、动态开关，下一帧没有旧图形残留。

### B03 / P2：隐藏时初次挂载或重渲染，恢复后可能永久停在静帧【静态条件路径】

- 位置：BotMark.tsx 的 animate = ... && !document.hidden 与 visibilitychange 监听。
- document.hidden 不是 React 状态。隐藏时 animate=false，组件不订阅时钟；可见时全局监听只启动已有订阅，不触发组件重新订阅。没有后续 React 重渲染就不能恢复。
- 修复：用响应式可见性状态，或始终注册启用动画的订阅者，仅在全局时钟层暂停；卸载清理对称。
- 验收：隐藏时挂载/收到数据，再恢复显示且无新数据到来，动画仍恢复；验证 Tauri 窗口真实 visibility 行为。

### B04 / P2：减少动态没有覆盖新增保留的巡游灯等动画

- 位置：UsageRing.tsx 的白点 animate-spin、刷新弧和 transition；reduceMotion 仅传 BotMark。
- 修复：全局设置与系统偏好共同控制所有持续动画；保留静态“正在使用/刷新”标记。系统偏好变化需要响应式监听。
- 验收：机器人与图标两模式下开启减少动态，持续白点和刷新旋转均停止，状态仍可辨认。

### R01 / P2：收纳条自动阈值未真正跟随通用设置【离线已复现，既有缺陷】

- 位置：src/railWarnings.ts，railConfig 与 evaluateRail。
- railConfig 已计算 red=warning_threshold；evaluateRail 又在 custom_thresholds=false 时强行改回 75/90。
- 复现：通用阈值 80、使用率 85，railConfig.red=80，但实际收纳条为黄色而非红色。
- 修复：直接消费归一化阈值，不重复用默认值覆盖。补充自动模式非 90 的测试。

### R02 / P2：版本号不一致，无法直接作为 0.6.0 发布

- package.json=0.6.0；package-lock.json、src-tauri/Cargo.toml、tauri.conf.json=0.5.2。
- 修复：使用统一版本脚本同步锁文件/配置，检查 EXE 元数据、安装包版本、便携包 manifest。产物须重建并绑定 commit/工作树状态/hash。
- 验收：界面、程序元数据、安装包、ZIP、更新清单一致。当前未重建或验收发布产物。

## 测试证据与覆盖限制

- 本次重跑 npm test：11 文件、82 项全部通过。
- 本次重跑 cargo test --locked --lib：95 项全部通过。
- 本次重跑 npm run build：TypeScript 与 Vite 构建通过。
- 临时离线探针 2 项通过，分别证明 R01 和 B01 的错误行为仍然存在；探针运行后已删除，不改变正常测试语义。
- 现有 StepFun 测试主要是成功解析样本，未覆盖三条保存入口的凭据合并、双端点失败矩阵、字符串套餐时间、零 Credit。
- BotMark.smoke.test.tsx 的“morph 最终隐没眼睛并画出特效”测试实际上只检查头部路径/transform 存在，没有断言眼睛隐藏或特效出现；不能作为相应功能验收证据。
- 未做真实账户联网验证、原生窗口动画切换、多个机器人持续性能测量、混合 DPI 或长期驻留；不宣称整个移植已无问题。

## 修复执行顺序与剩余工作

1. S01 凭据原子补丁 + S02 分来源结果模型，先确保不会丢 Key、不会静默丢现金。
2. S03–S07 数据语义：清错误、时间解析、零值、套餐名、现金/累计金额区分；补离线边界样本。
3. S08/S09 展示独立性、并发与错误处理；补双来源失败矩阵。
4. B01–B04 和 R01，补动画生命周期/事件语义/减少动态/阈值一致性回归。
5. R02，重建同源 EXE/ZIP；使用隔离配置验收保存、关闭重开、数据恢复、7 个机器人交互延迟与持续资源使用。

本次完成：两份文档核对、关键调用链静态审查、现有自动测试及构建复跑、两个补充离线复现、交接清单。剩余：上述修复、增加针对性回归、真实账号与原生窗口验证、发布产物一致性验收。所有问题当前均未在本次审查中修复。

## 外部依据

- StepFun 官方账户接口（本次读取）：https://platform.stepfun.com/docs/zh/api-reference/accounts/get
- CodexBar StepFun 实现文档（参考实现，不视为官方稳定协议）：https://raw.githubusercontent.com/steipete/CodexBar/main/docs/stepfun.md
