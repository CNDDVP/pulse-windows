# 安全政策 (Security Policy)

## 负责任的漏洞披露

Pulse for Windows 非常重视用户凭据与系统安全。如果您在本项目中发现了任何潜在的安全缺陷或隐私泄露漏洞，请切勿在公开 Issue 中讨论。

请通过以下方式提交安全报告：
- **GitHub 私密漏洞报告 (Private Vulnerability Reporting)**：在仓库的 `Security` -> `Advisories` 页面中点击 `Report a vulnerability`。

我们将在收到报告后的 48 小时内进行确认并展开排查，在修复补丁发布前对漏洞细节予以保密。

## 凭据安全原则

- 绝不向本地明文文件或日志输出存储用户 API Key 或访问令牌。
- 全量凭据通过 Windows 凭据管理器（Credential Manager）保存，由操作系统 DPAPI 提供加解密保障。
- 便携版通过动态 Profile 隔离机制避免换机时凭据混淆或泄漏。
