# ADR-0049: OPC 统一用户登录（手机号验证码唯一登录方式）

- Status: Superseded by [ADR-0050](../0051-email-registration-verification.md)（2026-10-20 当日经生产实测后终止：OPC OTP 发码对未录入身份假发送，不满足开放注册；登录回归邮箱体系）
- Date: 2026-10-20
- Amends: [ADR-0047](0047-account-license-and-official-ai.md) 第 19 段（"账号密码使用异步 scrypt"条款随邮箱体系移除而废止；该 ADR 其余决策——会话仅内存、代次隔离、权益只由官方服务授予、Kernel 只读准入事实——全部维持）
- Plan: [OPC 统一用户登录接入方案](../plans/2026-10-20-opc-unified-login.md)
- Related: [ADR-0048](0048-official-account-payment-settlement.md)（支付结算；本决策复用其网关凭证、签名内核与部署形态）
- 补充（2026-10-20 生产实测）：OPC 侧身份需**管理侧预先录入**（平台不自动注册）；未录入号码的发码为同形假发送——200 成功但运营商无短信，属防枚举设计（"真实发送与假发送走相同预算路径"）。运营口径：新用户开通 = 先在 OPC 录入手机号身份，再于 MetaWork 首次验证码登录自动建号。服务端成功发码日志 `opc_otp_sent`（challengeId + requestId + 脱敏号）用于与 OPC 核对回执。

## Decision

MetaWork 官方账号的唯一登录方式是**OPC OpenAPI v1 手机号短信验证码 + OpenID 长期绑定**。邮箱+密码注册/登录整体移除；首次验证码登录自动建号，无独立注册。

1. **机密客户端代理**：`client_secret` 只存在 official-server。本机 Server 与 Web 仅经 `/api/official-auth/otp/send|login` 透传；official-server 以 HMAC-SHA256 请求签名（与支付同内核，`hub-auth.js` 复用 `hub-payments.js` 规范串函数）调用 `POST /v1/auth/otp/send`（purpose=`OPENID_OP_AUTH`，发码即绑定 client）与 `POST /v1/auth/openid/authorize`，换取长期稳定的 `open_id`。平台不向第三方签发用户令牌。
2. **身份映射**：official-server `accounts.open_id`（UNIQUE，`^op_[A-Za-z0-9_-]{43}# ADR-0049: OPC 统一用户登录（手机号验证码唯一登录方式）

- Status: Accepted（本地实现与测试交付；生产切换依赖登录联调与同窗口发布）
- Date: 2026-10-20
- Amends: [ADR-0047](0047-account-license-and-official-ai.md) 第 19 段（"账号密码使用异步 scrypt"条款随邮箱体系移除而废止；该 ADR 其余决策——会话仅内存、代次隔离、权益只由官方服务授予、Kernel 只读准入事实——全部维持）
- Plan: [OPC 统一用户登录接入方案](../plans/2026-10-20-opc-unified-login.md)
- Related: [ADR-0048](0048-official-account-payment-settlement.md)（支付结算；本决策复用其网关凭证、签名内核与部署形态）
- 修订（2026-10-20，两次往返后定为 OpenID 授权）：身份锚点定为 OpenID `open_id`（`accounts.open_id`），发码 purpose=`OPENID_OP_AUTH`，challenge 经 `/v1/auth/openid/authorize` 换取长期绑定。中间曾短暂切换 `LOGIN` purpose + 自然人 `user_id` 锚点（经 `/v1/auth/login`），生产实测发现 OPC 对**未录入身份的手机号做同形假发送**（200 成功但运营商无短信，防枚举设计），即 `LOGIN` 流程要求号码预先在 OPC 管理侧录入——不满足开放注册需求，遂按用户决策还原为 OpenID 授权方案。**代价与前置：`OPENID_OP_AUTH` 受灰度 Gate 管控，上线必须由 OPC 将 `PAYMENT_HUB_CLIENT_ID` 加入 OpenID 白名单**（未放行时发码持续 503 `OPC_SYS_SERVICE_UNAVAILABLE`，生产实测）；`PAYMENT_HUB_CLIENT_ID` 参与 `open_id` 生成，是账号身份的一部分，不可轮换。
- 补充（2026-10-20 生产实测）：OPC 侧身份需**管理侧预先录入**（平台不自动注册）；未录入号码的发码为同形假发送——200 成功但运营商无短信，属防枚举设计（"真实发送与假发送走相同预算路径"）。运营口径：新用户开通 = 先在 OPC 录入手机号身份，再于 MetaWork 首次验证码登录自动建号。服务端成功发码日志 `opc_otp_sent`（challengeId + requestId + 脱敏号）用于与 OPC 核对回执。

## Decision

MetaWork 官方账号的唯一登录方式是**OPC OpenAPI v1 手机号短信验证码 + OpenID 长期绑定**。邮箱+密码注册/登录整体移除；首次验证码登录自动建号，无独立注册。

1. **机密客户端代理**：`client_secret` 只存在 official-server。本机 Server 与 Web 仅经 `/api/official-auth/otp/send|login` 透传；official-server 以 HMAC-SHA256 请求签名（与支付同内核，`hub-auth.js` 复用 `hub-payments.js` 规范串函数）调用 `POST /v1/auth/otp/send`（purpose=`OPENID_OP_AUTH`，发码即绑定 client）与 `POST /v1/auth/openid/authorize`，换取长期稳定的 `open_id`。平台不向第三方签发用户令牌。
2. **身份映射**：）是账号身份锚点；另存不可逆 `phone_hash`（`business.js` 共享函数 `phoneHash(ADMIN_TOKEN, 归一化手机号)`，server/admin 同源），供客服检索；`display_name` 存脱敏手机号。登录路径幂等回填 `phone_hash`/`display_name`，challenge 映射丢失（重启）或 `ADMIN_TOKEN` 轮换后自愈。**不做账号合并、权益不随身份迁移**；OPC 侧撤销绑定后再授权产生新 `open_id` → 新账号，旧权益不可自助找回（客服处置）。**二次放号**：OPC 身份以手机号为锚，运营商回收号码若被 OPC 视为同一用户，新持有人可经 OTP 继承旧权益——已接受的风险口径，客服可 `disable` 处置。
3. **凭证不变式**：`PAYMENT_HUB_CLIENT_ID` 参与 `open_id` 生成，**是账号身份的一部分，不可轮换**——更换 client 将孤儿化全部账号与权益（OPC 明确"跨 client 不关联"）。轮换需求出现时须另立 ADR 处理账号迁移。未配置 `PAYMENT_HUB_*` 时支付与 OPC 登录**一并关闭**（fail 一体）。
4. **会话与准入不变**：sessionToken 仍为 official-server 签发的 opaque 随机会话（库存 SHA-256 摘要），客户端仅存内存、重启重登；生产准入闸门照旧消费投影。**OPC 侧撤销绑定不注销本机已发会话**（会话由我方签发），仅影响下次登录。
5. **失败语义 fail-closed**：OTP 上游错误在路由本地映射（401 `opc_auth_failed` 统一话术不泄露原因；400 `otp_request_invalid`；429 `rate_limited` 透传 `Retry-After`；其余一律 503 `opc_auth_unavailable` + 告警日志），不进入支付语义的 `presentHubError`。短信类接口**禁止 429 自动重试**。disabled 账号在签发会话前拒绝（403 `account_disabled`）。
6. **滥用防线**：`/v1/auth/otp/send` 是公网未鉴权短信触发器。official-server 叠加本机限频（per-IP 复用 `AUTH_RATE_MAX`、per-phone 5/15min、**日预算熔断 `OPC_SEND_DAILY_MAX`**（默认 500，Asia/Shanghai 自然日、仅上游 200 计数、内存尽力而为））+ `opc_auth_unavailable`/预算告警日志；权威预算与限频在 OPC 侧。
7. **管理面**：无 email 后，admin.js 以 `open_id` 定位账号并新增 `accounts` 列表/`--phone`（stdin 读入，敏感值不进 argv）检索；`/v1/admin/accounts` 收敛为 `NODE_ENV==='test'` 专用建号 seam（生产 404）；测试夹具与探针脚本经 seam 建号/登录。
8. **管理员工具与客服口径**：客服按脱敏手机号（display_name）或 `accounts --phone` 定位账号；`grant-perpetual/revoke/disable/orders` 以 open_id 传参。

## Consequences

- **可用性从自控变为三方强依赖**：登录 = OPC 网关 + 短信通道 + OpenID 灰度 Gate + 全局短信日预算同时在线。叠加"会话仅内存、重启重登"，桌面端每次重启/更新/崩溃恢复消耗一条短信；OPC 侧"同号 60s 1 次、15min 5 次"意味着连续三次重启触发 15 分钟锁定。此成本模型**显式接受**。缓解路径（设备绑定的可撤销本地凭证）需进一步修订 ADR-0047 的"仅内存"条款，列为后续独立决策。
- 干净部署不再有注册流程与 scrypt 依赖；official-server 移除 `email`/`password_hash` 列与密码学凭证代码。
- 混合版本互斥：旧客户端（仅邮箱登录）对新服务端、新客户端对旧服务端均无法登录。切换依赖 §9 发布顺序（同窗口发版）且为**单向操作**（旧账号只存在于备份库）；无服务端版本闸门。
- 未来接入第二种身份通道（微信/Apple 等）时，应引入 `account_identities(provider, external_id)` 表并迁移，而不是再改 `accounts` 单列。
