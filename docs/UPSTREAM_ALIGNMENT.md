# 上游对齐台账（qunqin24/Pulse v1.2.1）

基线：上游 tag `v1.2.1`（commit `68fa829fcec85e3d44dd53801447809db714cde7`，2026-09-18）。
本地对应：dev 仓库 master（对齐开始于 v0.3.1，HEAD `d2389da` 之后；当前版本见仓库根 CHANGELOG）。
上游克隆：`（上游克隆）`（浅克隆，固定 tag）。

## 差异清单（持续更新）

| 功能 | 上游 | 本地 | 状态 |
|---|---|---|---|
| 每账号动画机器人（8 个性/18 形状/状态反应/视线） | BotMark/* | 复用上游 bot-data.json 的 SVG 渲染 | ✅ 批次 C |
| 点击圆环刷新单账号（合并/限流/键盘可达） | Docs/ui/input.md | 无 | ✅ 批次 A |
| 彩色刷新短弧（≥650ms，与请求生命周期绑定） | Docs/ui/input.md | 无 | ✅ 批次 A |
| CLI 工作状态采集（Claude/Codex，事件级） | UsageStore/ActivityStore | is_active 字段存在但后端从不赋值 | ✅ 批次 A（首版：Claude/Codex） |
| 沿边缘拖动（左右上下）+ 拖离自由悬浮 + 拖回吸附 | PanelPointerWatcher | 统一自定义拖拽 + 32/48 滞回 | ✅ 批次 B |
| 第二额度内环（可选） | Docs/ui/rings-and-surface.md | 同组最满自动/固定选择 | ✅ 批次 D |
| Antigravity 按模型组拆分展示（RailSlot） | Docs/ui/rings-and-surface.md | 每组一槽，同账号同刷新 | ✅ 批次 D |
| 小米 Coding Plan（第 19 个 Provider） | Docs/providers/xiaomi-coding-plan.md | Cookie 三路由+envelope 校验 | ✅ 批次 D |
| 悬浮栏右键菜单（设置/刷新/显隐/退出） | — | 原生右键菜单 | ✅ 批次 B |
| Codex helper CPU 空转修复 | 68fa829 | 不适用（macOS helper 管道路线不同） | 🪟 记录为 Windows 子进程 EOF/取消 测试项 |
| 更新检查间隔 2 小时 | 68fa829 | 自动更新未启用（按发布计划保持关闭） | 🪟 暂缓 |
| 悬浮详情卡 / 外圈时间环 / 通知 / 快捷键 / Token Spend | 有 | 有（Windows 形态） | ✅ 已对齐语义 |

## 批次 A 实现记录（本轮）

- `refresh_account(account_id)`：账号级强制刷新。与定时刷新共享 `AppState.refresh_slots`
  （Semaphore(4) 移入 AppState）；同账号并发合并（inflight 表）；删除/禁用账号后迟到响应
  以 settings 版本守卫丢弃；429 retry-after 透传并计入退避调度；结果走统一 reconcile/schedule/emit。
- 刷新运行状态事件 `refresh-state`：`{account_id, request_id, phase: started|finished, ok, kind}`，
  前端独立于读数状态渲染，不清空旧读数；前端保证最短 650ms 可见（提前结束也显示满时长）。
- 活动采集 `activity.rs`：增量读取 Claude（`~/.claude/projects/**/*.jsonl`）与 Codex
  （`~/.codex/sessions/**/*.jsonl`）新字节，事件分类 working/idle；归属规则：该 Provider 仅一个
  启用账号时才映射到账号，多账号一律 unknown（不广播）；每 5s 轮询，仅变化时 emit
  `activity-updated`；不向前端传递任何提示词/工具参数内容。
