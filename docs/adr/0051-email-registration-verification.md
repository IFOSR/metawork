# ADR-0051: 回归邮箱密码体系并在注册时验证邮箱

- Status: Accepted
- Date: 2026-10-20
- Supersedes: [ADR-0049](0049-opc-unified-login.md)（OPC 统一用户登录；已归档至 `docs/archive/adr/`）
- Amends: [ADR-0047](0047-account-license-and-official-ai.md)（其第 19 段"账号密码使用异步 scrypt，随机会话仅保存摘要"经 ADR-0049 废止后，由本决策**恢复有效**，并追加注册邮箱验证）

## Decision

官方账号登录回归**邮箱 + 密码**体系（原 ADR-0047 模型），并新增一项要求：**注册时必须验证邮箱有效性**。

1. **注册邮箱验证码**：`POST /v1/auth/email/code { email }` 向邮箱发送 6 位验证码（15 分钟有效）；`POST /v1/auth/register { email, password, code }` 校验通过后建号——注册成功即邮箱已验证，账号表无需额外验证状态列。
2. **验证码自管**：official-server 自生成、自校验（sha256 哈希存储、同邮箱单活动码、5 次尝试上限、重发作废旧码）；投递走**通用 SMTP**（nodemailer，`SMTP_HOST/PORT/SECURE/USER/PASS/FROM` 环境变量，凭证经 K8s Secret 注入）。未配置 SMTP 时注册返回 503 `email_unavailable`，已有账号登录不受影响。
3. **防滥用**：单邮箱 5 次/15 分钟、IP 复用 `AUTH_RATE_MAX`、本机日预算熔断 `EMAIL_DAILY_MAX`（默认 100/上海自然日）；验证码错误计入尝试。
4. **OPC 统一登录路线终止**（ADR-0049 的经验教训，均为生产实测）：
   - `OPENID_OP_AUTH` 发码受 OpenID 灰度 Gate 管控，Gate 未放行时持续 503 `OPC_SYS_SERVICE_UNAVAILABLE`；
   - `LOGIN` purpose 对**未录入 OPC 身份的手机号做同形假发送**（200 受理但运营商无短信，防枚举设计）——两个 purpose 都无法满足"任意手机号/邮箱开放注册"的产品需求；
   - 若未来需要绑定 OPC 身份（代操作、邀请码），在邮箱体系之上以 `account_identities` 扩展，不改动登录主链。
5. **不变式维持**：sessionToken 仍为 opaque 随机会话（库存摘要）、客户端仅存内存、代次隔离、生产准入只读投影；管理面 SSH loopback 不变。

## Consequences

- official-server 新增首个运行时外部依赖 `nodemailer`（此前零依赖）；镜像内 `npm ci` 安装。
- SMTP 投递延迟/垃圾箱是邮箱验证的固有特性，注册页需提示检查垃圾邮件。
- schema 迁移：`accounts` 回到 email 锚点。生产库在 1.1.1–1.2.0 期间为 open_id schema 且无真实用户，部署 1.3.0 前 DROP `accounts` 表即可（历史数据已有 PVC 备份）。
- OpenID 灰度白名单申请终止。
