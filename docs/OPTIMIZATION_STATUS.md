# 优化状态总汇

更新规则：每批记录代码改动、验证结果、剩余项；未通过验证不算关闭。

| 工作组 | 当前进度 | 剩余 |
|---|---|---|
| 审计基线 | 已保存 67 文件快照、固定上游 1.2.0 (commit 442a9c5)、18 Provider 和 54 Spend 来源矩阵、26 初始问题均已定位 | 随真实账号继续补充端到端证据 |
| 凭据与安全 (S01, S02) | ✅ 已全部迁移至原生 Windows Credential Manager (`CredWriteW`/`CredReadW`/`CredDeleteW`)；配置采用原子文件替换 (`MoveFileExW`)；损坏配置备份保留；前端仅接收脱敏 DTO | 生产环境长期运行稳定性监控 |
| Provider 体系 (P01-P07, F01) | ✅ 18/18 Provider 全量实现并经测试。含 4 复杂路线：Volcengine (AWS SigV4 HMAC-SHA256 签名器 + arkcli)、Command Code、Devin (API + Windsurf 本地 SQLite)、Ollama Cloud (Cookie + HTML 解析)；Kimi Code 与 OpenCode Go 已实测通 | 其余无账号 Provider 标注“代码已实现，待真实环境验证” |
| 刷新并发与缓存 (R01-R03) | ✅ 引入 Semaphore(4) 并发限制、账号独立作用域 SHA-256 隔离、退避机制与超时保护；任务失败返回结构化错误 DTO，旧读数标注过期状态 | 网络波动自愈观察 |
| Windows/UI 交互 (W01-W03, U01-U03) | ✅ 窗口预创建防死锁（阻止关闭改为 hide）、全局单实例互斥保证；支持左/右边缘贴靠自适应、动态指向尖角、有机法兰曲线与呼吸发光条；设置保存后广播 `settings-updated` | 物理多屏负坐标热插拔边界实机测试 |
| Token Spend (F02) | ✅ 增量扫描引擎与 SQLite 账本 (`ledger.rs`) 已实现，覆盖 Codex/Claude/Cline 等日志；前端 TokenSpend 页面提供 7/30/90 天过滤与按日聚合 | 更多三方 Agent 专有日志格式补充 |
| 构建与测试 (T01, B01, B02) | ✅ 34 项 Rust 单元与回归测试 100% 通过；4 项前端测试通过；前端打包与 Release 二进制构建通过 | NSIS Windows 安装包封包与离线环境验收 |

## 2026-09-17 第二轮：独立审计后的缺陷修复

| 类别 | 改动 | 验证 |
|---|---|---|
| 悬浮栏闪烁（用户报告） | `window.rs` 去掉 `SWP_NOCOPYBITS`/`SWP_DEFERERASE`（二者强制整窗擦除，透明窗口表现为“整体消失闪一下”）；保留单次 `SetWindowPos` 合并移动+缩放与无变化跳过 | 真机：悬停展开（90→475px）与移开收回各两轮，卡片即时弹出、圆环始终可见 |
| 托盘唤起后永不折叠 | `FloatingRail` 增加 `pinned` 状态替代误设 `inside`，到期自动解除 | 代码审查 + 构建 |
| H1 `ollama.rs` 多字节切片 panic | `slice_after` 退到字符边界 | 新增单测 |
| H2 `ledger.rs` 归档会话双倍计数 | codex 事件 id 去掉路径前缀（本身含时间戳+内容哈希）；扫描末尾清理已消失文件的遗留事件行 | 新增回归测试（移动到 `archived_sessions` 后计数不变、删除后清零） |
| H4 设置窗口回滚未保存编辑 | `appliedRef` 基线守卫：自身保存回声忽略；有未保存编辑时外部更新转为横幅提示而非覆盖 | tsc/lint/构建 |
| 配置损坏后应用“砖化” | `configuration_error` 改为可清除；`get_settings` 始终返回内存设置；UI 保存可覆盖损坏文件（覆盖前自动备份 `settings.json.<时间>.bak`） | 构建 |
| async 中阻塞调用 | 凭据读取/SQLite/凭据写入/settings 与 usage-cache 落盘迁至 `spawn_blocking`；devin SQLite 加 500ms busy_timeout | 34/34 测试 |
| 超时丢失旧读数回退 | 外层 25s 超时的错误 DTO 补上账号 scope | 构建 |
| 其他 | `parsers.rs` reset 时间 `saturating_add`；kimi 周限额不再双窗口；`unreachable!()` 改为错误返回；删除未编译的 `opencode.rs`；移除未用依赖 `tauri-plugin-log`/`log`/`framer-motion`/`lucide-react`/`clsx`/`tailwind-merge` 与 `App.css`；TokenSpend 请求序号守卫；`refresh_interval_seconds` 双边钳制；测试连接期间互斥其他保存；README 授权改为 Apache-2.0 并补充“必须用 `tauri build`”说明 | 全套通过 |

剩余：`window.rs` 每秒循环仍在 async 任务内直接调用 Win32（毫秒级，暂不处理）；antigravity 无凭据 scope，超时不回退旧读数；瞬时单帧过渡效果需用户实机确认。

## 2026-09-17 第三轮：审计尾项清零与提交拆分

| 类别 | 改动 | 验证 |
|---|---|---|
| H3 收尾 | 每秒窗口循环的显示器枚举/前台探测/重定位整体迁入 `spawn_blocking`；`secrets.rs` 凭据写入改为持有可变缓冲区（去掉 const 指针转换）；`ledger.rs` 去掉 `unwrap` | 34/34 |
| antigravity 超时回退 | 本地 RPC 无凭据，赋固定 scope `local-rpc`，超时/网络错误可回退上次读数 | 构建 |
| 解析健壮性 | `date()` 识别微秒/纳秒时间戳；codex `reset_after_seconds` 超过百年视为无效 | 新增断言 |
| 前端尾项 | `forecast` 统一以 `used_fraction` 为准（缺失时回退 percent/100）；`App` 只有设置加载失败才致命，读数/事件失败不再整页报错，去掉脆弱的 hash 探测；光晕仅统计 live/stale 读数，全部错误时显示灰色而非绿色；新增账号 `order` 取最大值+1 避免重复；`UsageDetailCard` 惰性初始化时间 | tsc/lint（剩 1 条风格提示）/4 项测试/构建 |
| 提交拆分 | 后端 / 前端 / 文档与工程 三批提交 | `git log` |

剩余（有意保留）：凭据 target 绑定配置目录哈希，`PULSE_DATA_DIR` 迁移后旧条目成为孤儿；每次刷新全量序列化比对并落盘 usage-cache.json（120s 一次小写入）；`FloatingRail` 折叠定时器 effect 内 setState 属合理用法保留；瞬时单帧过渡效果需用户实机确认。
