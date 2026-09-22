# StepFun 用量明细 HTTP 400

2026-09-22；版本号保持 0.6.4。

截图中套餐比例、Credit 剩余和现金余额成功，失败仅涉及用量明细。

官方公开前端 https://platform.stepfun.com/_next/static/chunks/9130-b989963ad83db06b.js 定义 QueryStepPlanUsagesRequest 字段为 start_time、to_time、page、page_size、granular_hour、project_ids。from_time 属于返回记录；本地原请求误用了 fromTime，且缺少 toTime。这是已确认的接口契约错误，但未读取该次真实 400 的响应正文。

修复使用 startTime/toTime 查询最近 24 小时，int64 按 protobuf JSON 字符串编码，granularHour 设置为 1。明细失败继续保留套餐和现金，不触发 Token 续期。

验证：cargo test --lib providers::stepfun，14 项通过，包含新增请求契约及部分失败回归测试。

待验证：真实服务接受新请求、页大小等服务端限制；完整分页仍待实现。未使用真实凭据请求服务，未重新生成或替换运行中的 EXE。此前审计报告的构建哈希不包含本补丁。
