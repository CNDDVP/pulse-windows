# 代码签名准备（Code Signing）——管道已就绪，等待购买与凭据

日期：2026-09-23。状态：**文档与集成点已就绪；实际签名需先购买服务并提供凭据**
（对齐审计 #21，唯一阻塞项是付费与外部账号，属用户决策）。

## 为什么需要

未签名的安装包/便携 EXE 会触发 Windows SmartScreen「未知发布者」警告与浏览器拦截，
是真实的新用户流失点（Token Monitor 上游即为代码签名安装包）。

## 三个选项（按推荐排序）

### 选项 A：Azure Trusted Signing（推荐，约 $9.99/月）

1. Azure 账号 → 创建 Trusted Signing 资源（需要组织验证，个人开发者身份 2024 起已支持）。
2. 拿到：Account Name + Certificate Profile Name + 一个有权签署的 Entra ID 凭据。
3. 本机安装 `Microsoft.Trusted.Signing.Client`（nuget 提供的 Azure.CodeSigning.DllSigntool）
   或使用 `signtool sign /dlib` 与对应 DLL。
4. 在 `scripts/build-dist.ps1` 的 NSIS/EXE 产物后接入签名步骤（见下「集成点」）。

### 选项 B：SSL.com eSigner（约 $129/年起，云签）

OV 证书，粒度与 A 类似；适合不想进 Azure 生态的情况。

### 选项 C：自签 + 文档引导（免费，仅消除「无证书」观感差异，SmartScreen 声誉仍为零）

仅建议作为过渡：`New-SelfSignedCertificate` + 用户手动信任根后安装警告减少，
但其他机器第一次仍会警告。**不作为正式方案**。

## 集成点（购买后 30 分钟内可接通）

1. `scripts/build-dist.ps1` 在 `[3/6] Assembling Portable Edition ZIP` 之前插入签名步骤：
   对 `src-tauri/target/release/pulse-windows.exe` 与 NSIS setup EXE 执行 signtool；
2. 签名参数从环境变量读取（`PULSE_TS_ACCOUNT` / `PULSE_TS_PROFILE` / `PULSE_TS_CREDENTIAL`），
   脚本检测到变量缺失时**跳过签名并打印 SKIPPED**（保持无凭据环境可构建）；
3. SHA256SUMS.txt 在签名后重新生成（签名改变文件字节）；
4. CI（Release workflow）增加同名 secrets 后自动产出签名版。

## 验收清单（购买后）

- [ ] `signtool sign /verify` 对两个产物返回通过；
- [ ] 全新 Windows 11 虚拟机首次运行不再出现 SmartScreen 全屏警告（声誉积累需数日下载量）；
- [ ] 重新生成 SHA256SUMS 并与 GitHub Release 资产一致。
