# StepFun 新 Token 仍查询失败：诊断与修复

## 已确认原因

上一轮修复新增的响应校验把 Dashboard RPC 的成功状态误写为 0。实际成功响应是 `status: 1`，因此正常套餐响应被拒绝为“服务未返回成功数据”。这是本地适配器回归，不是据此就能认定 Token 过期。

本次仅针对运行实例对应配置中的 StepFun 凭据进行一次只读查询，凭据仅留在进程内存，用于对应的 StepFun 官方服务。未打印/落盘 Token、设备 ID、账号 ID 或原始响应，未更改任何凭据。

安全摘要：

- 当前运行：src-tauri/target/release/pulse-windows.exe。
- 保存了网页 Token，未保存 API Key。
- 可提取设备声明，当前 Token 的设备声明没有冲突。
- 官方套餐端点返回 HTTP 200、业务 status=1，存在 plan_credit_rate_limit。
- 此次没有复现 HTTP 401，不能证明之前那次 401 的具体原因。

## 修复

- Dashboard RPC 按 status=1 判断成功，兼容字符串 "1"；拒绝 0、未知状态、缺失状态和非对象响应。
- API 余额 REST 接口使用独立验证规则，不套用 Dashboard 状态约定。
- 组合 Token 优先使用 refresh 部分的非空 device_id，再回退 access，避免两段设备声明不同时选错。
- 不向 UI 或日志透传未知服务端错误文本，避免响应回显泄露凭据。

## 验证与边界

- StepFun 相关 10 项 Rust 测试全部通过；包含成功业务状态贯通到额度解析、失败状态拒绝、REST 独立规则、设备声明优先级。
- 真实 Token 的只读 HTTP 验证成功；尚未退出用户当前实例或在新 EXE 中完成界面验收。
- 当前没有 API Key，人民币余额不会仅凭网页套餐 Token 自动出现；补填 API Key 会保留已有 Token。
- 修复前测试只覆盖了 merge/parser，遗漏 request 层的业务状态校验。本次新增该层回归。

参考实现（本次读取，另有上述实时 HTTP 证据）：https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/Providers/StepFun/StepFunUsageFetcher.swift

## 候选构建

Release 构建通过。路径：本地工作区内 `src-tauri/target/release/pulse-v060-stepfun-statusfix.exe`

SHA256：D14AB9F41A8B75532342C83EE6BF70A383A5FD110D942D9AD8A49FEF5092B04A

