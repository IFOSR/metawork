# MetaWork OPC 统一用户登录接入方案（手机号验证码登录，完全替换邮箱体系）· 含随版缺陷修复

- 方案日期：2026-10-20
- 状态：**2026-10-20 定版：放弃 OPC 登录路线，回归邮箱+密码体系并在注册时验证邮箱**（ADR-0051 取代 ADR-0049；手机号 OTP 对未录入 OPC 身份的号码只会假发送，"任意号码登录"在 OPC OTP 体系内无解，详见 §13 第七、八轮记录）。OPC 支付链路（ADR-0048）不受影响。镜像 **1.3.0** 已推送；客户端契约回到 login/register(email,password[,code])，Windows 包需重打 local-test-8。§12 三项随版缺陷修复同为本地已实施（第三项「登录与客户端页面进入时自动刷新权益」于 2026-10-21 并入，见 §12.4）。
- 实施完成日期：2026-10-20
- 合并说明：本计划吸收「捆绑 Pi 执行器」「能力说明生成优先使用用户固定模型」与「登录与客户端页面进入时自动刷新权益」三项随版缺陷修复为 §12；原 `docs/plans/2026-10-20-bundled-pi-executor.md`、`docs/plans/2026-10-20-capability-local-model-first.md` 与 `docs/plans/2026-10-21-client-entitlement-refresh.md` 已并入本文件并删除，内容与交付记录以 §12 为准。
- 交付验证：official-server `node --test` **31/31 通过**（既有支付/退款/管理回归全绿 + 新增 OTP 用例：首登建号/同 open_id 复用/phone_hash 落库与手机号明文不出库/错码 401 统一话术/open_id 协议防御 503/disabled 403 且无新会话行/本机手机号限频 429/上游 429 单次请求不重试且 Retry-After 透传/上游 503 fail-closed/发码日预算熔断/坏信封不消耗预算/连续签名失败时钟漂移告警/hub-auth 规范串文档向量/生产模式 seam 404 与 otp 503/邮箱路由移除后 401/管理面 accountId 查账）；主仓库 `tsc --noEmit` 通过 + 定向 vitest：authorization **25/25**、management 目录 **222 项中 221 通过**（唯一失败为既有 Windows 文件系统根路径用例，与本次无关；覆盖 otpLogin 主流程/代次隔离/未结束任务拒切换/sendOtp 透传与 Retry-After、新方法 HTTPS 契约与错误映射、management otp 路由 400/401/403 Origin/403 disabled/429+retryAfterSeconds/503/200 与旧邮箱路由 404）；`web npm run build` 通过。`pay-probe.mjs` 与 `local-pay-probe.mjs` 已删除；`real-hub-smoke.mjs` 已改 `NODE_ENV:'test'` + seam 建号；`admin.js incidents` 保留（§13#27）。**未执行**：真实 OTP 人工冒烟（测试网关 + 白名单测试号收码，见 §9/§7）与生产切换。
- 收尾提交：未创建提交，等待用户验证。
- 镜像打包（2026-10-20，WSL Docker 29.7.2）：`registry.cn-shanghai.aliyuncs.com/metafusion/official-server:1.1.0`（digest `sha256:6a2c28904dc15105ad538e9d580f883d5d82e4d86ad1cc10d00d55625770f7b9`），构建上下文 `official-server/`，按仓库要求带 `--provenance=false --sbom=false`；Dockerfile 的 COPY 清单补入本次新增的 `hub-auth.js`；容器冒烟通过（`/healthz` OK、未配凭证时 OTP 路由 503 `opc_auth_unavailable`、镜像内可加载 `hub-auth.js`）；`deploy/k8s/official-server.yaml` 镜像行同步为 `1.1.0`。**仅打包推送，未部署**——生产切换仍须先完成 §9 前置（OpenID 灰度白名单、`count(*)` 数据核对、旧库备份、同窗口发版）。
- 确认依据：用户确认**只保留手机号验证码登录**，邮箱+密码注册/登录整体移除，且**无存量用户**（无需迁移与账号绑定）。接口与签名以 OPC Hub OpenAPI v1 文档站（`https://opchub-docs.metafusion.cn/`，含 authentication、auth/send-otp、auth/login、auth/openid-login、auth/token、auth/revoke 各页）为准精确实现。
- 架构权威：[ADR-0047](../adr/0047-account-license-and-official-ai.md)（会话仅内存、权益只由官方服务授予、代次隔离等全部维持）；实施时新增 **ADR-0049**，**显式修订 ADR-0047 第 19 段**（"账号密码使用异步 scrypt"条款随邮箱体系移除而废止），并登记 `docs/adr/README.md` 权威矩阵。
- 复用依据：OPC 统一支付已接入并经真实网关验证（[2026-10-14 支付接入方案](2026-10-14-official-account-payment-integration.md)）；本方案复用其 HMAC 签名内核、网关凭证与部署形态。

## 1. 现状分析（接入前用户体系）

| 层 | 现状 | 关键位置 |
| --- | --- | --- |
| 本地账户域（ADR-0031） | `Principal`/`Account`，生产只装配 `local-default` 单账户；Gateway socket 无 token 认证（0600 文件权限即信任边界）；本地身份（web cookie、desktop 票据、飞书 principal）与商业身份解耦 | `src/account/`、`src/gateway/authenticator.ts`、`src/server/server-composition.ts` |
| 商业身份域（ADR-0047） | 用户登录在自建 official-server：邮箱+密码注册、scrypt 存储、opaque sessionToken（库存 SHA-256 摘要）、`licenses` 按 revision 发放权益；客户端会话**仅存内存**，重启需重新登录；生产准入闸门要求投影 `state === 'active'` | `official-server/server.js`、`src/authorization/local-authorization-service.ts`、`src/server/server-composition.ts`（productionAuthorization） |
| OPC 支付接入 | 签名内核：7 字段规范串 + HMAC-SHA256（密钥 `client_secret`），四头 `X-Client-Id/X-Timestamp/X-Nonce/X-Signature`；凭证 `PAYMENT_HUB_BASE_URL/CLIENT_ID/CLIENT_SECRET`；时间窗 300,000 ms | `official-server/hub-payments.js`、`official-server/server.js`（paymentEnv） |

**OPC OpenAPI v1 登录接口要点**：

- `POST /v1/auth/otp/send`：签名认证；body `{provider:'OTP_MOBILE', identifier:<11 位手机号>, purpose}`；purpose 必须用 `OPENID_OP_AUTH`（发码即绑定 API Client，是 OpenID 授权登录的唯一配套用途）。返回 `challenge_id`、`masked_target`、`expires_in_seconds=300`、`retry_after_seconds=60`；无论账号是否存在同形返回（防枚举）；OPC 侧限频：同 target 60s 1 次、15min 5 次，另有 IP/client 分钟限额与全局短信日预算。
- `POST /v1/auth/openid/authorize`：签名认证；body `{grant_type:'otp_mobile', challenge_id, code}`；返回 `open_id`（`op_` + 43 位 Base64URL，共 46 字符；**跨 client 不关联、撤销后不复用**）与 `created` 标志；**长期绑定**，后续代用户操作无需重新 OTP；不返回任何 token 或内部 user_id。
- 选择 `openid/authorize` 而非 `/v1/auth/login` 是唯一可行路径：后者只返回 `user_id` 且"不通过登录自动注册"，我方在 OPC 侧无预置身份，无法 find-or-create。
- `POST /v1/auth/token`（client_credentials 应用令牌）、`POST /v1/auth/revoke`：本期登录不依赖；`hub-auth.js` 预留 `exchangeAppToken`/`revokeToken` 供后续邀请码核销（`invite:redeem`）等场景。
- 错误面（openid/authorize）：400 `OPC_PARAM_INVALID`（字段缺失/格式非法）；401 `OPC_AUTH_LOGIN_FAILED`（验证码错误/过期/身份不存在，统一话术）与签名/凭证族；**403（client 无权执行授权流程、绑定因安全状态不可用）**；429 限流（带 `Retry-After`）；503 依赖不可用（fail-closed）。
- **短信类接口禁止 429 自动重试**（发码不可自动重发）。
- **前置条件（平台侧）**：OpenID 灰度 Gate 同时覆盖发码（OPENID_OP_AUTH）、授权绑定、邀请码核销三段；Gate 未启用或 client 不在名单时发码/绑定返回 503/403。上线前需向 OPC 申请将我方 `PAYMENT_HUB_CLIENT_ID` 加入白名单。

## 2. 目标与分层

| 决策点 | 结论 |
| --- | --- |
| 登录方式 | **仅手机号+短信验证码**；邮箱+密码注册/登录从前端到服务端整体移除 |
| 注册 | 无独立注册；首次验证码登录 find-or-create 自动建号 |
| 身份锚点 | OPC `open_id`（长期绑定）→ official-server `accounts.open_id`（UNIQUE，格式 `^op_[A-Za-z0-9_-]{43}$` 校验） |
| 手机号留存 | 另存不可逆 `phone_hash` = `HMAC-SHA256(ADMIN_TOKEN, 'metawork/phone/v1:' + 归一化手机号)` 小写 hex；构造收敛为 `business.js` 共享函数 `phoneHash(secret, phone)`，`server.js` 与 `admin.js` 同源 import 保证逐字节一致；不存明文 |
| 会话 | 维持 ADR-0047：官方服务签发自有 opaque sessionToken，客户端仅存内存，重启重登（短信成本模型见 §11，已显式接受） |
| 权益/订单/支付 | 零改动：仍挂 `account_id`；trial/月/年、二维码支付、退款、管理端全部沿用 |
| 凭证 | 复用 `PAYMENT_HUB_*`（同 Base URL、同 client_id/secret），**无新增 Secret**；唯一新增 env 为可选 `OPC_SEND_DAILY_MAX`；client_id 为账号身份一部分、**不可轮换**（不变式见 §11） |
| 部署 | 无存量用户，账号 schema 直接重建；上线时一次性重置 `data/official.sqlite`（前置校验与备份见 §9） |

**必须遵守的既有契约**（ADR-0047，除第 19 段账号密码条款由 ADR-0049 修订外）：

1. 权益只能由官方服务授予；客户端只透传与投影，不产生权益事实。
2. sessionToken 与权益投影不落盘；登录代次（generation）隔离，异步响应不得串号。
3. 生产准入只读投影事实（`state === 'active'`），Kernel 不感知登录细节。

## 3. 系统边界

```text
Web / Desktop（手机号验证码登录）
        │  /api/official-auth/otp/*（本机会话 cookie + Origin 校验）
        ▼
本机 MetaWork Server（LocalAuthorizationService，仅透传与投影）
        │  HTTPS（发码无需会话；登录响应携 sessionToken）
        ▼
MetaWork 官方服务（official-server，机密客户端角色）
        │  HMAC-SHA256 签名四头（复用 hub-payments.js 规范串）
        ▼
OPC Hub OpenAPI v1（/v1/auth/otp/send → /v1/auth/openid/authorize）
        └── open_id → find-or-create accounts → 签发 sessionToken + entitlement
```

client_secret 只存在 official-server；本机 Server 与 Web 永不接触签名凭证。

## 4. official-server 后端

### 4.1 新模块 `official-server/hub-auth.js`（零依赖 ESM）

- `createHubAuthClient({ baseUrl, clientId, clientSecret, timeoutMs = 15000, fetchImpl })`，复用 `hub-payments.js` 已导出的 `canonicalHubRequest`/`signHubRequest`；HTTPS 强制（`NODE_ENV==='test'` 豁免 `http://127.0.0.1`，同支付客户端）、15s 超时、`redirect:'error'`、信封 `code !== 'OK'` 抛 `HubError`。
- 方法：
  - `sendOtp({ identifier, purpose = 'OPENID_OP_AUTH' })` → `POST /v1/auth/otp/send`，body `{provider:'OTP_MOBILE', identifier, purpose}`；返回 `{challengeId, maskedTarget, expiresInSeconds, retryAfterSeconds}`。
  - `openidAuthorize({ challengeId, code })` → `POST /v1/auth/openid/authorize`，body `{grant_type:'otp_mobile', challenge_id: challengeId, code}`；返回 `{openId, created}`。
  - 预留：`exchangeAppToken({ scope })`、`revokeToken(token)`（本期不被路由调用）。
- **与支付客户端的关键差异：429 不自动重试**（短信不可自动重发，429 直接抛 `HubError`）。
- **`HubError` 扩展 `retryAfterSeconds`**：上游 429 时从 `Retry-After` 响应头读取并随身携带，供本地路由透出（`HubError.retryable` 全仓无消费者，不改动）。不触碰 `hub-payments.js` 的支付重试语义。

### 4.2 `official-server/server.js` 改造

**账号模型重建**（无存量用户，直接改 schema，不做兼容迁移）：

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  open_id TEXT NOT NULL UNIQUE,        -- OPC OpenID：op_ + 43 位 Base64URL，写入前格式校验
  phone_hash TEXT,                     -- phoneHash(ADMIN_TOKEN, 归一化手机号)，客服检索用，不可逆（business.js 共享函数）
  display_name TEXT NOT NULL,          -- 首登时的脱敏手机号（如 138****8000），唯一的对外展示名
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

- 移除列 `email`/`password_hash`；`accountView` → `{ accountId, displayName }`（单一展示字段，不另设 maskedPhone）；`authenticate()` 的 `SELECT s.*, a.email, a.display_name` 同步改为 `a.display_name`。
- 移除函数 `register`/`credentials`/`hashPassword`/`verifyPassword`/`dummyPassword`/`activePasswords`、`promisify`/`scrypt` 导入与 email 维度限频；`node:crypto` 仅保留 `createHash`/`createHmac`/`randomBytes`/`timingSafeEqual`（digest/phone_hash/发号用）。
- 部署时一次性重置 `data/official.sqlite`（前置校验与备份要求见 §9）。

**新增路由**：

- `POST /v1/auth/otp/send { phone }`：
  - 归一化（去空白/分隔符/可选国码前缀）后校验 `^1[3-9]\d{9}$`，非法 → 400 `invalid_phone`；
  - 限频：`opc-otp:<ip>`（默认 10/min）、`opc-phone:<hash>`（默认 5/15min）；
  - **本机日预算熔断（尽力而为的滥用熔断，非精确配额）**：`opc-send-daily` 内存计数（env `OPC_SEND_DAILY_MAX`，默认 500），窗口为 **Asia/Shanghai 自然日**（与 OPC 全局预算口径对齐），**仅上游 200 计入**（上游故障不消耗预算）；内存形态即重启清零、多副本不共享（现状单副本拓扑可接受），精确配额由 OPC 主控；超限 429 `sms_budget_exhausted` + 告警日志 `opc_auth_send_budget_exhausted`——防公网滥用打穿 OPC 全局短信日预算；
  - 未配置网关凭证 → 503 `opc_auth_unavailable`；
  - 代理 `hubAuth.sendOtp` → 返回 `{ challengeId, maskedPhone, expiresIn, retryAfter }`（429 时带 `Retry-After` 响应头）；
  - `challenge_id → { phone, maskedPhone }` 存内存 Map（TTL 600s > 验证码 300s 有效期），挂现有 60s retention 清理；登录时由 phone 计算 `phone_hash`，明文不落库。
- `POST /v1/auth/otp/login { challengeId, code }`：
  - 限频：`opc-login:<ip>`（默认 10/min）；
  - 代理 `hubAuth.openidAuthorize` → `open_id`；格式不符（`^op_[A-Za-z0-9_-]{43}$`）→ 503 `opc_auth_unavailable`（协议防御）；
  - 事务内 find-or-create（`BEGIN IMMEDIATE` 串行化，并发双建天然互斥）：按 `open_id` 查 `accounts`；不存在则建号（`display_name` = Map 中的脱敏手机号，缺省 `'OPC 用户'`）；**幂等回填**：Map 中有手机号且存量行 `phone_hash` 为 NULL 或与本次计算不一致时，`UPDATE phone_hash` 与 `display_name`——challenge Map 重启丢失只推迟到下次登录自愈，`ADMIN_TOKEN` 轮换后旧哈希随各账号下次登录刷新；
  - **签发前判 `disabled`**：`fail(403, 'account_disabled')`，不留下垃圾会话行、不给客户端短暂 active 投影；
  - 签发 sessionToken（`randomBytes(32).base64url`，库存 SHA-256 摘要）；
  - 返回 `{ sessionToken, account: accountView(row), entitlement: entitlement(row.id) }`。

**错误映射（关键实现约束：OTP 路由在本地 try/catch 内完成全部映射，HubError 不得逃逸到 `route()` 顶层 `presentHubError`，否则 429 会被翻译成 `payment_hub_busy`、OPC_* 原样透出为支付语义错误码）**：

| 上游 | 出口 |
| --- | --- |
| `OPC_AUTH_LOGIN_FAILED`（401） | 401 `opc_auth_failed`（统一话术，不泄露原因） |
| 400 `OPC_PARAM_INVALID` | 400 `otp_request_invalid` |
| 403（Gate/安全状态不可用绑定） | 503 `opc_auth_unavailable` + error 日志（平台侧状态，用户侧话术"暂不可用"） |
| 签名/凭证族（401：INVALID_SIGNATURE、TIMESTAMP、NONCE、INVALID_CLIENT、CLIENT_EXPIRED） | 503 `opc_auth_unavailable` + error 日志（我方凭证/时钟问题，非用户错误） |
| 429（`HubError.retryAfterSeconds`） | 429 `rate_limited` + **`Retry-After` 响应头与 body `retryAfterSeconds` 字段**（`send()` 扩展可选 headers 参数，向后兼容；body 字段供 UI 倒计时直接消费） |
| 503 / `OPC_DEPENDENCY_UNAVAILABLE` / 网关不可达 | 503 `opc_auth_unavailable`（fail-closed）+ 告警日志 `opc_auth_unavailable`（含频次，供值班发现通道劣化） |
| 其余 `OPC_*` / 非预期上游状态 | 503 `opc_auth_unavailable` + error 日志（catch-all fail-closed，与支付方案口径一致） |

**旧邮箱路由移除后的行为**：`POST /v1/auth/register`、`/v1/auth/login` 不再有前置分支，未携带 Bearer 的请求命中 `authenticate()` 守卫返回 **401 `session_invalid`**（不新增遗留路径特判 404 的死代码；§7 测试按 401 断言）。

### 4.3 管理面（随 email 体系整体改写）

- `POST /v1/admin/orders`：查账键由 `{email}` 改为 `{accountId}`。
- `POST /v1/admin/accounts`：由"邮箱+密码建号"改为**测试专用建号 seam**——`{openId, displayName?, phone?}`（phone 仅测试显式提供时算 phone_hash）；仅 `NODE_ENV==='test'` 生效，生产恒 404。这是移除 register 后唯一的服务端建号入口（正式用户走首登自动建号）。
- `admin.js`：
  - `grant-perpetual/revoke/disable/orders` 的账号定位由 email 改为 **`<open-id>`**（`SELECT id FROM accounts WHERE open_id = ?`）；
  - 新增 `accounts` 子命令：列出 `id/open_id/display_name/phone_hash/disabled/created_at`（最近 50 条），并支持 `--phone`——**手机号从 stdin 读入，不进 argv**（ps/shell history 可见 argv，维持本脚本"敏感值不进 argv"的既有注释约定），主机本地经共享 `phoneHash()` 检索；
  - 提示语"register from MetaWork first"改为"account not found; users self-create on first OTP login"。

## 5. 本地客户端链路（主仓库）

- `src/authorization/types.ts`：`OfficialAccount` 改为 `{ accountId, displayName? }`（`email` 移除，不设 maskedPhone 冗余字段）；`OfficialAuthorizationError` 错误码枚举：增 `otp_failed`/`otp_unavailable`/`account_disabled`/`rate_limited`（实例可携带 `retryAfterSeconds`），随邮箱登录移除 `invalid_credentials`。
- `src/authorization/official-service-client.ts`：
  - 移除 `login(email, password)`、`register`；
  - 新增 `sendOtp(phone)` → `POST /v1/auth/otp/send`，zod 校验返回 `{challengeId, maskedPhone, expiresIn, retryAfter?}`；
  - 新增 `otpLogin(challengeId, code, client?)` → `POST /v1/auth/otp/login`，复用原 login 响应解析（sessionToken ≥32 位 + account + entitlement）；
  - `request()` 错误映射：`opc_auth_failed` → `'otp_failed'`（"验证码错误或已过期，请重新获取"）、`opc_auth_unavailable` → `'otp_unavailable'`（"手机号登录暂时不可用，请稍后重试"）、`account_disabled` → `'account_disabled'`（"账号已被停用，请联系客服"）、`sms_budget_exhausted`/`rate_limited` → `'rate_limited'`（"请求过于频繁，请稍后重试"）——**Retry-After 端到端闭环**：Hub 响应头 → `HubError.retryAfterSeconds` → 服务端 `Retry-After` 响应头 → 客户端读 429 响应头写入 `OfficialAuthorizationError.retryAfterSeconds`，经管理端 JSON body 下发到 UI；
  - `parseAccount` 改为新账号形状（`displayName` 可选，上限 120）。
- `src/authorization/local-authorization-service.ts`：
  - `Client` Pick 类型由 `'login' | 'register' | ...` 改为 `'sendOtp' | 'otpLogin' | ...`；
  - 移除 `login(email, password)`、`register`；
  - 新增 `sendOtp(phone)`：纯透传（未登录态可调）；
  - 新增 `otpLogin(challengeId, code)`：完整沿用原 `login()` 守卫——`disposed`、`token`/`loginPending` 防重入（already_logged_in）、generation 代次隔离（过期响应即 logout 作废）、`lastAccountId` 未结束任务拒切换、`accept(entitlement)`、`schedule()`。
- `src/management/server.ts handleOfficialAuth`：
  - 移除 `/api/official-auth/register`、`/api/official-auth/login` 分支；
  - 新增 `POST /api/official-auth/otp/send { phone }`、`POST /api/official-auth/otp/login { challengeId, code }`；
  - 沿用 cookie 会话无关性（登录前可调）、`no-store`、Origin 校验；错误状态映射增：`otp_failed` → 401、`otp_unavailable` → 503、`account_disabled` → 403、`rate_limited` → 429（响应 JSON body 带 `retryAfterSeconds`，供 UI 倒计时）。

## 6. Web UI（Desktop 自动继承）

`web/src/components/OfficialAccountPanel.tsx` 登录卡片只留手机号登录：

1. 手机号输入 + 「获取验证码」按钮（60s 倒计时；提示 5 分钟内有效；429 时按响应 body 的 `retryAfterSeconds` 提示剩余秒数，缺失时——如本机 `rate()` 触发的 429 走 SafeError 通道无该值——回退通用话术）；
2. 6 位验证码输入 + 登录按钮；
3. 移除邮箱/密码输入、注册切换与注册表单；
4. 错误文案直接展示服务端映射后的中文提示（验证码错误/过于频繁/暂不可用/账号已停用）；
5. 已登录区显示 `displayName`（首登脱敏手机号，如 138****8000），其余（套餐、订单、二维码支付）不变。

## 7. 测试

`official-server/test/service.test.js`（沿用"桩上游 + 子进程真服务 + 直查 SQLite"模式，桩 Hub 服务器新增 OpenAPI auth 端点）：

- **建号夹具（seam，单一方案）**：`POST /v1/admin/accounts {openId, displayName?, phone?}`（loopback + ADMIN_TOKEN，服务端 `NODE_ENV==='test'` 才生效，生产恒 404）——test 模式下建号后**直接签发会话**并返回 `{ accountId, sessionToken, displayName, entitlement }`；`registerLogin()` 内部改调 seam，open_id 由既有 email 参数确定性派生，**16 处调用点零改动**；该返回同时是探针脚本的登录态来源。
- **签名**：`hub-auth.js` 按文档示例向量验证规范串与签名；桩上游重算四头核对；连续签名失败触发时钟漂移告警。
- **发码**：成功返回 challenge/maskedPhone；本机 IP/手机号限频 429；非法号码 400；未配置凭证 503；OPC 429 透传且**不自动重试**（桩断言单次请求）+ `Retry-After` 头透传；`OPC_SEND_DAILY_MAX` 熔断生效。
- **登录**：首登 find-or-create 建号 + 发会话 + 返回权益（含 phone_hash 落库断言）；同 open_id 二次登录复用账号（事务串行化路径）；错码 → 401 `opc_auth_failed` 统一话术；open_id 格式不符 → 503；上游 429/503/403/签名族 → 映射正确且**不出现 `payment_hub_busy`**；连续签名失败触发 `opc_auth_clock_skew_suspected` 告警；hub-auth 规范串按文档向量断言；**disabled 账号 403 `account_disabled` 且 sessions 无新行**。
- **落盘隐私（原邮箱体系断言的改写与保留）**：`accounts` 表不含手机号明文（仅 open_id/phone_hash/脱敏 display_name）、`sessions` 表不含明文 token（仅 SHA-256 摘要）——沿用原 L161-172"不含明文密码"断言的保护强度，改写而非删除。
- **移除（official-server 侧）**：匿名 `POST /v1/auth/login`、`/v1/auth/register` → 401 `session_invalid`（auth 守卫先于路由，见 §4.2）。
- **管理面**：`/v1/admin/orders` 按 accountId 查账；`/v1/admin/accounts` 测试 seam 生效、生产模式（非 test env 的隔离进程）404。
- **回归**：既有 trial/订单/支付/退款/管理端用例全部保持通过（仅夹具建号方式调整）。

**探针/冒烟脚本**：`pay-probe.mjs` 与 `local-pay-probe.mjs` **删除**——前者默认目标是公网生产地址且从不携带 `Authorization`（注释即 "Credentials are not needed"），不可能改走 loopback admin seam；后者依赖已移除的本地邮箱登录路由；两者的响应形状/本地调试职责由桩测与 `real-hub-smoke.mjs` 覆盖。`real-hub-smoke.mjs` 保留改造：本就以测试网关与测试凭证运行，spawn 子进程 env **显式加 `NODE_ENV: 'test'`**（当前仅从父进程继承，seam 会 404），建号/登录改走 seam；连带效应是放开 `PAYMENT_HUB_BASE_URL` 的 HTTPS 启动校验，实际 URL 仍为 HTTPS，无影响。真实 OTP 登录冒烟（测试网关 + 白名单测试号真实收码 → openid/authorize → 建号 → 会话）列为**人工交付门槛**，不进自动化。

主仓库定向 vitest：

- `tests/authorization/local-authorization-service.test.ts`：otpLogin 主流程、代次隔离（过期响应作废）、未结束任务拒切换账号、重复登录 409。
- `tests/authorization/official-service-client.test.ts`：sendOtp/otpLogin HTTPS 契约与错误码映射（含 otp_failed/otp_unavailable/account_disabled/Retry-After 话术）、协议失败 fail-closed；移除邮箱登录用例。
- `tests/management/server.test.ts`：新路由 403（Origin）/400/401/403（disabled）/429/503/200；旧 `/api/official-auth/register|login` 移除后走分支末尾返回 **404 `not_found`**（management 侧 404 与 official-server 侧旧路由的 401 分属两层，分别断言）。

## 8. 文档交付

- 新增 `docs/adr/0049-opc-unified-login.md`，**声明修订 ADR-0047 第 19 段**（账号密码 scrypt 条款废止，身份改为 OPC OpenID 绑定），其余 ADR-0047 决策维持；写入：机密客户端代理、open_id↔accounts 映射、phone_hash 留存与共享构造、sessionToken 仍仅内存、**client_id 为账号身份一部分不可轮换**、**不做账号合并、权益不随身份迁移**、二次放号语义（§11）、**OPC 侧撤销绑定不注销本机会话**（sessionToken 由我方签发，仅影响下次登录——防止误读为"撤销应立即踢下线"）、重启重登的短信成本模型、灰度 Gate 前置条件、未来第二种身份通道（微信/Apple）应引入 `account_identities(provider, external_id)` 表而非再改 accounts；登记 `docs/adr/README.md` 权威矩阵。
- 本计划文档实施后回填"实施完成日期/交付验证/收尾提交"。
- 更新 `docs/current/official-account-operations.md`：登录路由变更、部署步骤（数据前置核对、一次性重置 official.sqlite、备份保留）、OPC OpenID 白名单申请、告警与值班处置（发码速率/`opc_auth_unavailable`/短信预算）、回滚条件；`official-server/README.md` 接口清单、管理命令（open_id/`accounts` 子命令）、限频说明同步。
- 更新 `official-server/.env.example`：`PAYMENT_HUB_*` 注释改为"未配置时**支付与 OPC 登录**一并关闭"；新增 `OPC_SEND_DAILY_MAX`。
- 更新 `docs/current/technical-overview.md`、`CONTEXT.md`（官方账号段落：`without PAYMENT_HUB_*` 表述扩为"支付与统一登录一并关闭"）、`docs/README.md` 导航（本计划与 ADR-0049）。

## 9. 部署与平台事项

- **上线前置数据核对（强制）**：停服后对旧库执行 `SELECT count(*)` 校验 `orders`/`order_payments`/`licenses`/`payment_incidents`/`accounts`；**任一非空则中止切换并人工确认**（"无存量用户"是业务前提，代码必须核实后才允许重置）。`payment_incidents` 若有未决项，先按 ADR-0048 流程处置完毕。
- **旧库保留为回滚备份**：`official.sqlite`（含 WAL/SHM）移入带日期的备份路径，**保留至新版全链路验收通过后**再归档；不是删除。
- **OpenID 灰度 Gate**：上线前向 OPC 平台申请将 `PAYMENT_HUB_CLIENT_ID` 加入白名单；Gate 未开通时发码 503/403，手机号登录整体不可用（唯一登录方式），**Gate 开通与服务端切换必须在同一维护窗口内协同**。
- **发布顺序（混合版本互斥的唯一保障）**：删除旧路由后，任意"旧客户端×新服务端"或"新客户端×旧服务端"组合都无法登录，且旧库重置后旧账号不存在——切换是**单向操作**。发布顺序：① 服务端在维护窗口内完成 Gate 开通 + 新版部署 + 数据核对重置；② 客户端（Web 随服务、Desktop 经自动更新）同窗口发版。**不设服务端版本闸门**（评审第三轮 P0：`METAWORK_VERSION` 全仓只读无写入、`client.version` 常态缺失；替代源 releaseId 非 semver；且陈旧安装的本地 Server 只含邮箱登录代码，根本不会调用 `/v1/auth/otp/login` 而是撞 401——闸门拦不到目标场景，fail-closed 反而拦死所有新客户端）；同窗口发版即为互斥保障，陈旧客户端的服务端表现统一为 401 `session_invalid`。
- **回滚完整条件**：仅当新版验收失败时——恢复备份旧库 + 回退服务端版本 + 客户端强制降级/停更，三者同时满足才可回到邮箱登录形态；缺一不可（旧账号只存在于备份库）。回滚后需重新评估 Gate 时序再排期。
- **仅新增可选 env `OPC_SEND_DAILY_MAX`**：复用 `PAYMENT_HUB_*`，无新增 Secret。生产凭证经 K8s Secret 注入（现状）。
- nginx：`/v1/auth/otp/*` 走现有 `/v1/*` 代理，无配置变更；按 IP 限频依赖 `TRUST_PROXY=1` 的可信 nginx 覆写 `X-Real-IP`（现状约束，直连外网不得开启——文档重申）。
- **本地开发/联调路径**：Web UI 登录只有真实短信一条路，无绕过；开发联调 = 本地/测试 official-server（`NODE_ENV=test`，seam 预置账号与登录态）+ `METAWORK_OFFICIAL_SERVER_URL` 指向测试网关配置 + **白名单测试号真实收码**走完整 otp 流程。
- 测试网关 `https://opc-openapi.dev.metafusion.cc` 用于真实 OTP 人工冒烟（测试凭证 + 测试环境白名单 + 真实测试号收码）。

## 10. 实施顺序

1. official-server：`hub-auth.js` + `server.js`（schema 重建、路由、账号映射、管理面改写、移除邮箱体系）+ 服务端测试（含 seam 夹具与探针脚本改造）；
2. 主仓库：types/client/service/management 改造 + 测试；
3. Web UI；
4. ADR-0049 + 计划文档回填 + 运维/README/.env.example/CONTEXT 同步；
5. 验证：`npm run lint`（Windows 宿主）+ `node --test`（official-server，node:sqlite 为 Node 22 内置）+ 主仓库 authorization/management 定向 vitest；不跑全量套件（遵循仓库 Windows 指引）。

§12 两项随版缺陷修复与上述步骤同窗口交付，不改变该顺序。

## 11. 风险与已接受决策（写入 ADR-0049）

- **可用性从自控变为三方强依赖**：登录 = OPC 网关 + 短信通道 + OpenID 灰度 Gate + 全局短信日预算四者同时在线；叠加 ADR-0047"会话仅内存、重启重登"，桌面端每次重启/更新/崩溃恢复都要消耗一条短信，OPC 侧"同号 60s 1 次、15min 5 次"意味着连续三次重启即触发 15 分钟锁定。此成本模型**显式接受**；缓解路径（设备绑定的可撤销本地凭证）需修订 ADR-0047"仅内存"条款，列为后续独立决策，不在本期实施。
- **凭证耦合与不可轮换**：`PAYMENT_HUB_CLIENT_ID` 参与 open_id 生成，**是账号身份的一部分，不可轮换**——换 client 将孤儿化全部账号与权益（文档明确"跨 client 不关联"）；关闭支付配置会连登录一并关闭（fail 一体的部署事实，写入运维文档）。凭证轮换需求出现时须另立 ADR 处理账号迁移。
- **不做账号合并、权益不随身份迁移**：open_id 撤销后重新授权产生新 open_id → 新账号，旧账号权益不可自助找回（客服经 `disable/revoke` + 新账号重新购买/补发处理）。
- **二次放号语义**：OPC 身份以手机号为锚，若运营商回收号码后 OPC 侧视为同一用户，新持有人可经 OTP 继承旧账号付费权益；MetaWork 侧不做额外防护，客服可 `disable` 处置，记录为已接受口径。
- **滥用面**：`/v1/auth/otp/send` 是公网未鉴权短信触发器；本机二层限频在 `TRUST_PROXY` 未按约束配置时退化为全站聚合限额；`rates` 表满 2 万键后统一 429。防线：本机日预算熔断（`OPC_SEND_DAILY_MAX`）+ 发码速率与 `opc_auth_unavailable` 告警日志 + 对外话术与值班处置（§8/§9）。
- **短信预算耗尽**：全局预算由 OPC 主控（上海时区自然日重置），耗尽当日全员无法登录；对外话术"手机号登录暂时不可用"，值班按运维文档确认预算状态。

## 12. 随版缺陷修复（并入项）

本节合并三份随版修复计划（原 `2026-10-20-bundled-pi-executor.md`、
`2026-10-20-capability-local-model-first.md` 与 `2026-10-21-client-entitlement-refresh.md`）。
前两项与 §1–§11 同属一个发版窗口：统一登录解决了「用户能不能进来」，这两项解决「进来之后
能不能装上执行器、能不能生成能力说明」——若不同时交付，登录切换完成后会立刻撞上下一道断点。
§12.4 补的是「进来之后看到的权益状态是否属实」，与前两项同窗口交付，不改登录契约与发布顺序。

### 12.1 能力说明生成优先使用用户固定模型

**问题**：设置页「能力更新」（智能体能力说明生成）此前固定走官方内置 AI
（`/v1/ai/operation`，服务端 `MODEL_*` 凭证 + 权益门控）。官方 AI 不可用
（如 `official_ai_unavailable`、`daily_limit`）时该功能即被卡死；而能力更新只在用户
已固定模型后才有意义，此时用户 Provider 凭证已在本地配置中，Server 具备直接调用能力。

**方案**：`InternalLlmService` 增加 `preferredModel` 通道——对 `capability_explanation`
操作，优先解析用户固定模型（能力更新入参 `models[].modelRef` → 活跃配置
`models`/`providers` → 凭证引用 → SecretStore 解析 API Key），本地直调该 Provider 的
OpenAI 兼容 `/chat/completions`（60s 超时；**不发 `temperature` 等采样参数**，2026-10-21
统一，参数交由 Provider 默认值）；生成提示词随产品内置
（`agent-capability-description-prompt.ts`，与官方服务提示词同一产出契约）。本地失败
或未解析到模型时回退官方内置 AI（现有路径、权益门控不变），无官方通道时保留本地错误；
固定模型缺少可用凭证抛 `PreferredModelError`，直接呈现而不静默回退。

边界：使用用户自己的模型不消耗官方资源，不改变 ADR-0047 内置 AI 的权益定位；官方内置
AI 降级为兜底通道；anthropic 协议 Provider 暂不参与本地路径（回退官方）。

**2026-10-21 扩展（模型资料提炼同样优先用户模型）**：

**问题**：模型资料提炼（`/api/config/model-routing-profile`，`model_summary` 操作）此前
**只**走官方内置 AI。用户已在 Provider 卡片里配置好自定义模型（自带端点与 API Key），
点「获取模型信息」时公开资料/能力/价格都能取到，唯独能力描述整理这一步要求登录官方
账号，未登录即报 `HTTP 500 请先在本机 Web 或 Desktop 登录 MetaWork 官方账号。`——这与
「用户已配置模型就应优先用它」的预期相反，也与 §12.1 的能力说明生成口径不一致。

**方案**：把 `preferredModel` 从「按操作固定」扩展为「按调用方指定引用」：

- `InternalLlmService.generate()` 接受可选 `preferredModel: { providerRef, modelId, baseUrl? }`
  （**只含引用，不含凭证**），解析器在装配层把它解析为可用传输。
- `ModelRoutingProfileService.summarize()` 透传该引用；`/api/config/model-routing-profile`
  接受可选 `providerRef`/`modelId`/`baseUrl`，`providerRef` 与 `modelId` 必须成对出现。
- 装配层解析规则：已激活配置里的 Provider 优先（端点与凭证引用均由本机配置给出）；
  尚未激活的新 Provider 则**端点只认可官方公开预设**（客户端提交的 `baseUrl` 仅作预设
  查找键，不会成为任意代理目标），凭证按 Provider 引用在本机凭据库中查找。
- **解析不到就如实呈现**：调用方明确指定了用户模型，解析失败时抛 `PreferredModelError`
  并写明原因（凭证缺失 / 端点非公开预设 / Provider 未激活），不再静默回退官方内置 AI 把
  真实原因盖住。解析逻辑独立为 `src/configuration/preferred-model-resolver.ts`，可单测。
- 客户端只发送引用，`apiKey` 一律不参与；未指定用户模型时不带任何端点。
- **本地直调必须带产出契约提示词**：新增 `src/configuration/model-summary-prompt.ts`，与官方服务
  `model_summary` 提示词同一契约（summary/strengths/limitations/preferredTaskTypes/
  avoidTaskTypes JSON）。此前本地直调没有提示词，只发了一句泛化英文指令，用户自己的模型
  不知道 MetaWork 的字段约定，返回内容解析失败（"模型信息提炼结果不完整或格式无效"）。
- 直调**不发采样参数**（`temperature` 等），交由 Provider 默认值：固定订阅模型
  （如 `kimi-for-coding` 只接受 `temperature=1`）不再因参数校验被拒。
- 两条通道都失败时合并呈现根因：「用户配置模型（X）本地调用失败（…），官方内置 AI
  兜底亦失败（…）」，不再只显示官方那一侧的错误。

**改动清单**：`src/configuration/internal-llm-service.ts`（`PreferredModelReference`、
`generate` 入参、解析器入参、合并错误文案）、`src/configuration/model-routing-profile-service.ts`、
新增 `src/configuration/preferred-model-resolver.ts`（端点与凭证解析，失败即报错）、
`src/management/server.ts`（`ConfigQuery` 与路由校验）、`src/server/server-composition.ts`
（调用解析器）、`web/src/api/http.ts`、`web/src/components/SettingsPanel.tsx`；
测试 `internal-llm-service.test.ts`（用户模型优先、失败回退并合并报错）、
新增 `preferred-model-resolver.test.ts`（已激活 Provider、未激活预设、凭证缺失、端点不匹配）、
`management/server.test.ts`（引用透传与成对校验）、新增
`tests/web/model-information-transport.test.ts`（只发引用、不带凭证）。

**交付（2026-10-21，本机实施与验证；未提交、未推送）**：

- 验证：`tsc --noEmit`（仓库根 + `web`）通过；`tests/configuration` + `tests/web` +
  `tests/management` + `tests/authorization` 共 871 项中 863 通过，8 项失败为工作区既有
  Windows POSIX 权限/符号链接/Composer IME 用例，与本次无关。
- 已知坑（用户在 Windows 上实测）：**首次激活失败时凭证写入会被回滚**（协调器对候选凭证
  采用补偿事务），所以"Kimi Provider 填了 Key 但激活因为缺价格失败"之后，Key 实际没有落库，
  用户模型通道解析不到凭证。必须**重新填一次 API Key 并让激活成功**，Key 才会真正写入
  `file-secret:anyfusion/providers/<providerRef>`。
- 端到端（点「获取模型信息」走用户自定义模型）需一个已配置并成功激活的 Provider 账号会话，
  由用户在 Web 上复验。

**改动清单**：`src/configuration/internal-llm-service.ts`（`preferredModel` 依赖、本地优先
/官方兜底路由、`completeOnPreferredModel`）；新增
`src/configuration/agent-capability-description-prompt.ts`；
`src/server/server-composition.ts` 解析用户固定模型 → Provider 凭证
（`assertSecretReference` + SecretStore）；测试 `internal-llm-service.test.ts` 四条路由
用例（本地优先成功、本地失败回退官方、未解析到模型保持官方、配置错误直接呈现）。

**交付（2026-10-20，本机实施与验证；未提交、未推送）**：

- 提示词与官方服务同一产出契约（summary/abilities/boundaries JSON，禁止模型名与产品宣传）。
- `server-composition` 仅让 `openai-compatible` 且启用的 Provider 参与；anthropic 回退官方。
- SettingsAssistant、模型路由建议两个既有官方 AI 功能行为不变（本次未切）。
- 验证：`tsc --noEmit` 通过；记录时 `internal-llm-service` 路由用例 + 既有用例、能力描述
  服务用例、授权用例共 35/35 通过（2026-10-20 合并自查复跑同范围 39/39）；
  构建 `0.1.18-local-test-5` 并更新本机安装，服务正常
  启动、就绪 API 正常、安装内 dist 含能力说明内置提示词与新路由代码。
- 端到端（登录态点击「能力更新」走用户模型）需已配置 Provider 并固定模型的账号会话，
  由用户在 Web 上复验。

**已知跟进**：

- 固定了目录模型但对应 Provider 未配置凭证时，现给出精确提示（`PreferredModelError`：
  「固定模型缺少可用的 Provider 凭证…」），不再误显示为官方内置 AI 不可用；后续可在
  固定模型下拉里过滤/标注未配置凭证的目录模型。
- fork `packages/ai` 的 `build` 脚本会从上游实时数据再生成 `models.generated.ts` 等文件，
  可能引入与手写兼容类型不匹配的字段；本仓库构建一律使用 `build:offline`（不生成）+
  直接 bun compile，勿在 fork 内跑 `build`/`build:binary`（污染源树，git checkout 可还原）。
- `packages/ai` 预存类型错误需上游侧修复（本次通过还原生成文件绕过）。

### 12.2 捆绑 Pi 执行器（随产品分发）

**问题**：Pi Agent 是必需的执行器，但此前安装产品后需要用户自行安装，且 Windows 上
存在不可绕过的断点：

1. npm 全局包在 Windows 生成 `pi.cmd` 垫片与无扩展名 sh 脚本，`PiCliDriver` 用
   `execFile` 直接 spawn，Node 拒绝执行（EINVAL/超时）；`shell: true` 又会触发 cmd.exe
   8191 字符长参数截断（历史真实事故）。
2. npm 包名有陷阱：`@mariozechner/pi` 的 bin 是 `pi-pods`，执行器是
   `@mariozechner/pi-coding-agent`。
3. 「安装指引」按钮指向开发者向的 GitHub 仓库页，对普通用户不可操作。

macOS/Linux 上 npm 全局包是符号链接 + shebang，一条命令可用；但「要求用户自己装执行器」
的摩擦是三平台共有的产品缺口。

**方案**：Pi 从「用户自备的外部依赖」改为「产品自带组件」，与 Desktop 已有的
`desktop-tools/executor/bin/pi` 同一模式扩展到 Server/CLI 安装：

- **构建期**：`build-release.mjs` 在 bun 可用时于
  `planner/AnyFusion-Pi/packages/coding-agent` 下直接执行
  `bun build --compile ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile dist/pi`
  （不走 fork 的 `build:binary` 链：其 `packages/ai` 预存类型错误，见 12.1 已知跟进），
  产物 `packages/coding-agent/dist/pi(.exe)` 随 planner 归档白名单条目
  `packages/coding-agent/dist` 自动进入安装包；bun 不可用时跳过（仅告警），不阻塞
  构建。CI 的 `windows-release.yml` 与 `internal-runtime-release.yml` 加
  `oven-sh/setup-bun`。
- **安装/启动期**：`native-launcher.ts` 双平台模板以 `if not defined` / `:=` 模式设置
  `METAWORK_MANAGED_PI` 指向
  `app/current/planner/packages/coding-agent/dist/pi(.exe)`；`resolveExecutorTool` 的托管
  分支（既有）优先生效，用户可用同名环境变量覆盖为自己的 Pi。
- **验证**：executor 就绪解析到托管路径，probe 可执行并返回版本（编译产物当前报
  `0.0.0`，见已知跟进）。

执行器与 Planner 出自同一 vendored fork，版本严格一致、零漂移；安装全程离线，不引入
npm/网络依赖。

**改动清单**：`scripts/build-release.mjs`（bun 探测 + 直接 `bun build --compile` 产出
`dist/pi`）；
`.github/workflows/windows-release.yml`、`.github/workflows/internal-runtime-release.yml`
（`setup-bun`）；`src/installation/native-launcher.ts`（双平台 `METAWORK_MANAGED_PI`）；
随附修复 `src/utils/executor-tool-path.ts`（Windows PATHEXT 候选顺序 `.exe/.cmd/.bat`
优先于裸名，裸名是 POSIX 脚本，不可执行）；测试 launcher 双平台断言与 PATHEXT 顺序回归。

**交付（2026-10-20，本机实施与验证；未提交、未推送）**：

- `build-release.mjs` 在 bun 可用时自动编译出 `dist/pi(.exe)`（`bun build --compile`，
  输入 `dist/bun/cli.js`），随 planner 归档进入安装包；bun 缺失时跳过并告警，构建不停。
  bun 探测兼容 Windows 的 `.cmd` 垫片（shell 回退探测）。
- `native-launcher.ts` 双平台以保留用户覆盖的模式设置 `METAWORK_MANAGED_PI` 指向随包二进制。
- 随附修复：`resolveExecutorTool` Windows 候选顺序 `.exe/.cmd/.bat` 优先于裸名，附回归测试。
- 验证：`tsc --noEmit` 通过；launcher/executor 聚焦测试通过（native-launcher 2 个 POSIX
  渲染用例为 Windows 主机既有失败，stash 基线确认）。本机全流程：构建
  `0.1.18-local-test-3`（planner 归档 20.1MB → 113.7MB，含 `dist/pi.exe` 108.6MB）→ 全新
  安装 → readiness API：Pi `status=installed`、`path=安装内捆绑 pi.exe`、`managed=true`；
  期间全局 `where pi` 为空（零外部依赖）；更新事务与 `server start/stop` 此前已在同环境
  验证通过。

**已知跟进**：

- bun compile 产物 `--version` 输出 `0.0.0`（编译产物运行时读不到 package.json 版本），
  就绪页版本显示 0.0.0——cosmetic，待对齐上游编译期版本注入。
- release 事务与迁移 staging 两处指针保持 symlink（理由见代码注释），Windows 上需要
  Developer Mode 的场景仅剩这两处。

### 12.3 与登录切换的关系

- 两项修复不改变 §2 的登录契约与 §9 的发布顺序，只影响同一窗口内交付的安装包内容。
- 登录切换属**单向操作**（旧库重置后旧账号不存在），因此这两项必须在本窗口一次性带出：
  Pi 缺失会让新装用户无法执行任务，官方 AI 不可用会让「能力更新」对已固定模型的用户
  报错——都会在登录切换后被误判为登录方案缺陷。
- 两项均为本地验证完成、代码未提交；随本计划一并提交，收尾提交口径同文末。

### 12.4 登录与客户端页面进入时自动刷新权益

**问题**：官方账号权益此前只在三个时机被在线核验——生产性请求经 Gateway 核验、活动工作
达到 24 小时基准后的后台核验、以及用户在账号窗口手动点击「刷新权益」。登录响应虽然带回
一份权益快照，但客户端登录后仍提示用户自行选择套餐或刷新权益；再次打开客户端页面时，
顶部权益标识只反映本机旧投影，可能已经过期或被撤销。

**方案**：

- 账号登录成功：本机 Server 在接受登录响应的权益快照后，立即再在线核验一次，登录后的
  权益状态一律以在线核验结果为准。
- 进入客户端页面（已登录）：客户端在页面挂载时请求本机 Server 刷新权益，Server 对已有
  官方会话执行在线核验并回写投影；未登录时该请求只返回本机投影，不产生官方网络流量。
- 周期轮询保持原样：本地 UI 每五秒只读一次本机投影，不产生官方核验流量。
- Desktop 与 Web 共用同一份 Web 客户端，Desktop 重新进入页面同样刷新；TUI/飞书不新增
  页面刷新入口，仍由 Gateway 生产性准入在线核验，拒绝时引导到 Web/Desktop。

**边界**：不改变官方服务的 `/v1/entitlement` 协议、登录响应结构与支付回调结算；登录后刷新
与页面进入刷新都复用既有 `verifyForProduction()` 单飞与代次隔离路径，不新增第二套权益判定，
失败仍按既有策略降级（无法确认权益即暂停新工作）；不放宽任何准入条件，权益状态、Kernel
事实与 Gateway 拒绝路径保持不变。

**改动清单**：`src/authorization/local-authorization-service.ts`（`login()` 内在线核验一次）；
`web/src/components/OfficialAccountPanel.tsx`（页面挂载刷新、登录提示语反映核验后状态）；
`tests/authorization/local-authorization-service.test.ts`、`tests/management/server.test.ts`、
新增 `tests/web/official-account-refresh.test.ts`；ADR-0047 §11 与 2026-10-21 修订段、
`CONTEXT.md`、`docs/current/official-account-operations.md`、`docs/current/technical-overview.md`
同步。

**交付（2026-10-21，本机实施与验证；未提交、未推送）**：

- 登录后权益以在线核验结果为准，登录响应里的权益只是登录瞬间的快照。
- 页面进入刷新在未登录时由 Server 直接短路，不产生官方网络流量。
- 验证：`tsc --noEmit`（仓库根 + `web`）通过；定向 vitest **89/89 通过**（authorization 15、
  management server 授权用例、新增 web 刷新用例 3）；既有 `tests/architecture/*`、
  `tests/web/composer-ime`、`tests/management/workspace-directory-browser` 失败为工作区既有问题，
  与本次无关（分别指向 `src/installation/paths.ts`、`src/configuration/legacy-configuration-reader.ts`、
  `web/src/components/Composer.tsx` 与 Windows 根路径处理）。

## 13. 评审修订记录（2026-10-20）

| # | 级别 | 修订 |
| --- | --- | --- |
| 1 | 事实错误 | §4.3 改写：`admin.js` 四命令由 email 改 open_id 定位 + 新增 `accounts` 列表/`--phone` 检索；`/v1/admin/orders` 改 `{accountId}`；`/v1/admin/accounts` 改测试专用 seam（原计划称"admin.js 不变"系错误，`orders/grant-perpetual/revoke/disable` 均按 email 查库） |
| 2 | 事实错误 | §4.2 补 `authenticate()` SELECT 投影同步修改；明确移除 `promisify`/`scrypt`/`dummyPassword`；`accountView` 收敛为单一 `displayName`（原 `maskedPhone` 与之同源冗余） |
| 3 | 事实错误 | §4.2/§7：旧 `/v1/auth/login|register` 匿名请求命中 `authenticate()` 返回 401 而非 404，测试按 401 断言（原计划断言 404 会失败） |
| 4 | 事实错误 | §8/ADR-0049 显式声明**修订 ADR-0047 第 19 段**（scrypt 账号密码条款），并登记权威矩阵（ADR README 要求声明 amend/supersede） |
| 5 | 无效改动 | 删除"retryable 集合补 `OPC_DEPENDENCY_UNAVAILABLE`"——`HubError.retryable` 全仓无消费者，不触碰支付模块 |
| 6 | 完整性 P0 | §7 新建号 seam（test-only `/v1/admin/accounts`）与探针脚本改造；真实 OTP 冒烟列为人工交付门槛 |
| 7 | 完整性 P0 | §9 上线前置 `count(*)` 数据核对、旧库保留为回滚备份、版本闸门（`client.version` → 409 `client_upgrade_required`）、发布顺序与回滚完整条件（单向操作） |
| 8 | 完整性 P1 | §4.2 错误映射补 400/403 两行；明确 **OTP 错误本地 try/catch 映射、不进 `presentHubError`**；Retry-After 端到端链路补全（`HubError.retryAfterSeconds` → `send()` 扩展 headers → 客户端解析话术） |
| 9 | 强健性 | §4.2 登录签发前判 `disabled`（403 `account_disabled`），不依赖下游 JOIN 守卫；open_id 写入前格式校验；find-or-create 并发防护（实现为 `BEGIN IMMEDIATE` 事务串行化，等价于原拟的 UNIQUE 冲突回读且更简单） |
| 10 | 强健性 | 新增 `phone_hash`（HMAC 不可逆）留存与 admin 检索；ADR-0049 写入不可轮换 client_id、不做账号合并、二次放号、重启重登短信成本模型、`account_identities` 未来路径 |
| 11 | 强健性 | §4.2/§11 新增本机日预算熔断 `OPC_SEND_DAILY_MAX`、发码速率与 `opc_auth_unavailable` 告警、`TRUST_PROXY` 依赖重申 |
| 12 | 同步面 | §8 明确 `.env.example`（"未配置仅关支付"→"支付与 OPC 登录一并关闭"）、`official-server/README.md`、`CONTEXT.md`、`docs/README.md` 四处同步 |

**第二轮评审（2026-10-20）**：

| # | 级别 | 修订 |
| --- | --- | --- |
| 13 | P1#1 | §7 `pay-probe.mjs` 改为**删除**（公网目标 + 从不带 Authorization，不可能走 loopback admin seam；原"脚本本就在持有 ADMIN_TOKEN 的主机上运行"判断错误）；`real-hub-smoke.mjs` spawn 显式 `NODE_ENV:'test'`（原从父进程继承，seam 会 404），并说明 HTTPS 启动校验连带放开但实际 URL 仍为 HTTPS |
| 14 | P1#3 | 版本闸门客户端侧闭环：`client_upgrade_required` 进 `OfficialServiceClient` 错误映射与管理端 409；`client.version` 缺失一律 409（fail-closed），最低版本为服务端常量（非 env） |
| 15 | P2#1 | phone_hash 构造定稿：`business.js` 共享 `phoneHash(secret, phone)` = HMAC-SHA256(`ADMIN_TOKEN`, `'metawork/phone/v1:' + 归一化手机号`)，server.js/admin.js 同源 import，杜绝两处实现漂移导致客服检索静默落空 |
| 16 | P2#2 | §4.2 登录幂等回填：challenge Map 有手机号且存量行 `phone_hash` 为 NULL/不一致即 UPDATE（含 display_name）——Map 重启丢失与 ADMIN_TOKEN 轮换均自愈 |
| 17 | P2#3 | Retry-After 补完最后两跳：客户端 `rate_limited` 独立错误码（不再折叠进 `request_rejected`）+ `retryAfterSeconds` 属性；管理端 429 + JSON body 下发；§6 UI 倒计时不再是死分支 |
| 18 | P2#4 | 日预算语义定稿：Asia/Shanghai 自然日（与 OPC 口径对齐）、仅上游 200 计数、内存尽力而为（重启清零、单副本拓扑可接受） |
| 19 | P2#5 | `admin.js --phone` 手机号改 **stdin 读入**，不进 argv（与脚本"敏感值不进 argv"既有注释一致，防 ps/shell history 泄露） |
| 20 | P2#6 | §2 "无新增环境变量与 Secret" 改为"无新增 Secret；新增可选 `OPC_SEND_DAILY_MAX`；最低客户端版本为服务端常量" |
| 21 | P3 | 错误映射补 catch-all 行（其余 OPC_*/非预期状态 → 503 + 日志）；§7 夹具定稿为单一方案（seam test 模式直接返回会话，兼作探针登录态）；official-server 侧 401 与 management 侧 404 分层断言；`invalid_credentials` 随邮箱登录从枚举移除；§9 增本地开发/联调路径；ADR-0049 补"撤销绑定不注销本机会话"语义；`phone_hash` 索引评估为可省（表小） |

**第三轮评审（2026-10-20）**：

| # | 级别 | 修订 |
| --- | --- | --- |
| 22 | P0 | **删除版本闸门**（§4.2/§5/§9 同步移除 `client_upgrade_required`/`MIN_CLIENT_VERSION`）。证据链：`METAWORK_VERSION` 全仓只有读取无任何写入（`client.version` 常态 undefined，JSON.stringify 丢键）；替代源 releaseId 非 semver（`-build-` 后缀使分段数值比较得 NaN）；闸门对准的陈旧安装只含邮箱登录代码，不会调用 `/v1/auth/otp/login`（撞 401 `session_invalid`）——闸门拦不到目标场景，fail-closed 却拦死所有新客户端与本地开发路径。互斥保障回归 §9 发布顺序（同窗口发版）本身 |
| 23 | 小项 | §9 env 表述合并为"仅新增可选 env `OPC_SEND_DAILY_MAX`"（消除与 §2 已修正表述的结构性重复） |
| 24 | 小项 | 删除"seam sessionToken 注入本地内存登录态"——`LocalAuthorizationService` 无注入入口，该路径不可执行；开发联调仅保留测试网关 + 白名单测试号真实收码 |
| 25 | 小项 | §6 补兜底：本机 `rate()` 触发的 429 走 SafeError 通道、无 `Retry-After`，`retryAfterSeconds` 缺失时 UI 回退通用话术 |
| 26 | 小项 | §7 补落盘隐私断言改写：原"accounts 不含明文密码"改为"`accounts` 不含手机号明文、`sessions` 不含明文 token"——OTP 体系下保留并强化该保护，不在改夹具时丢失 |

**第四轮评审（2026-10-20，实施后核查）**：

| # | 级别 | 修订 |
| --- | --- | --- |
| 27 | P1 | **恢复 admin.js `incidents` 子命令**——重写 admin.js 时被计划外覆盖删除，而 usage/README/ops 文档与 §9 上线前置（未决 payment_incidents 须按 ADR-0048 处置）都依赖它 |
| 28 | P2 | 删除 `test/local-pay-probe.mjs`（仍调用已移除的本地邮箱登录路由，且其历史调试职责已由 real-hub-smoke 覆盖） |
| 29 | P3 | `official-service-client.ts` 错误映射移除死键 `invalid_account`（服务端已不再产生，且为邮箱话术残留）；删除零引用的 `DEV_OFFICIAL_SERVICE_URL` 导出（开发入口由 `METAWORK_OFFICIAL_SERVER_URL` 承担） |
| 30 | P3 | `deploy/k8s/official-server.yaml` 移除无消费者的 `EMAIL_RATE_MAX`，补 `OPC_SEND_DAILY_MAX` 注释样例 |
| 31 | 测试缺口 | management 补 400/403 `account_disabled`/503 `otp_unavailable` 三档断言；新增连续签名失败触发 `opc_auth_clock_skew_suspected` 告警测试；新增 hub-auth 规范串文档向量断言 |
| 32 | 表述回填 | §4.2/§7/§13#9 "UNIQUE 冲突回读"改为实际的 `BEGIN IMMEDIATE` 事务串行化 find-or-create（语义等价）；§4.2 429 行补记 body `retryAfterSeconds` 字段（实现优于计划，UI 倒计时需要） |

**第五轮评审（2026-10-20，实施后核查 #2）**：

| # | 级别 | 修订 |
| --- | --- | --- |
| 33 | P1 | `otpSend` 补 Hub 响应形状检查（与 `otpLogin` 的 open_id 检查对称）：`challenge_id` 缺失/长度不符的 200 信封 → 503 `opc_auth_unavailable` + `opc_auth_protocol_invalid` 日志，且**不消耗日预算**（原实现会让客户端落到协议错误且预算已计）；桩测覆盖（`OPC_SEND_DAILY_MAX=1` 隔离实例：坏信封 503 后同号正常发码仍成功） |
| 34 | P2 | Web 倒计时同步：修改手机号即清零重发锁（换号可立即发码）；429 带 `retryAfterSeconds` 时同步进倒计时（按钮锁窗，不再重复点击消耗每 IP 限频）；成功文案改用服务端 `expiresIn` 而非硬编码"5 分钟" |
| 35 | P3 | `hub-auth.js` Retry-After 解析收紧：无头/非正值（`Number(null)===0`）一律归 null，语义明确（现双守卫下行为等价） |
| 36 | 文档 | 头部测试口径修正：247/246 为 management(222/221) + authorization(25/25) 合并数；ops 证据节补 2026-10-20 登录改造后的 30/30 新基线 |

**第六轮评审（2026-10-20，LOGIN 切换）**：

| # | 级别 | 修订 |
| --- | --- | --- |
| 37 | 方案切换 | **身份锚点 `open_id` → 自然人 `user_id`，purpose `OPENID_OP_AUTH` → `LOGIN`**。生产实测：1.1.0 部署后发码持续 503 `OPC_SYS_SERVICE_UNAVAILABLE`，与文档"灰度 Gate 未启用或 client 不在名单时返回 503"吻合——`OPENID_OP_AUTH` 属"已绑定用户的代操作授权"而非普通登录，Gate 拒绝是正确行为。用户确认后切换：`hub-auth.js` 新增 `loginWithOtp`（`POST /v1/auth/login`，返回整数 `user_id`），`server.js` 账号锚点改 `accounts.opc_user_id`（UNIQUE 正整数），seam 参数 `openId` → `userId`，admin.js 定位键同步。连带修订：`PAYMENT_HUB_CLIENT_ID` 不再是账号身份的一部分（user_id 平台级，轮换不孤儿化账号）；OpenID Gate 白名单不再是上线前置。**客户端链路零改动，无需重打包 Windows 安装包**。服务端镜像 1.1.1 已构建推送（容器冒烟通过），k8s 清单同步。文档同步：ADR-0049 修订注记 + 六处活文档锚点改写。 |
| 38 | 生产实测 | **OPC 侧身份须管理侧预先录入**（平台不自动注册）：未录入号码发码为同形假发送（200 成功但运营商无短信，防枚举设计），换已录入号码后全链路打通。镜像 **1.1.2** 补成功发码日志 `opc_otp_sent`（challengeId/requestId/脱敏号，纯增量，便于与 OPC 核对回执）；运营口径写入 ADR-0049 与 ops 文档。登录闭环生产验证通过。 |

**第七轮决策（2026-10-20，定版还原 OpenID 授权）**：用户确认开放注册需求（`LOGIN` 流程要求号码预先录入 OPC，不满足）后，曾提出"自管验证码 + 通用短信（sms:send）"方案；最终用户决策**还原为 OpenID 授权流程**（purpose=`OPENID_OP_AUTH` + `/v1/auth/openid/authorize`，锚点 `open_id`）。已还原：hub-auth.js/server.js/admin.js/测试桩（31/31 通过）与全部活文档锚点表述；保留期间改进（坏信封形状检查、日预算不计数假发送、发码成功日志、Retry-After 链路）。镜像 **1.2.0** 已构建推送（digest sha256:9b0c3e97...090e3），k8s 清单同步。**上线前置回到：OPC 将 client_id 加入 OpenID 灰度白名单**；部署时 DROP accounts 表（1.1.1/1.1.2 期间为 opc_user_id schema）后换镜像。

**第八轮决策（2026-10-20，需求变更：回归邮箱体系 + 注册邮箱验证）**：用户要求不再依赖 OPC 身份体系——任何邮箱都能注册登录，只需注册时验证邮箱有效性。定版方案（ADR-0051）：

1. **official-server**：恢复 email+password 体系（scrypt、credentials 校验、login/register 路由、sessions/licenses/orders 链路原样）；新增 `POST /v1/auth/email/code`（自管 6 位验证码：sha256 存储、TTL 15 分钟、5 次尝试上限、同邮箱重发作废旧码、per-邮箱 5/15min + IP 限频 + 日预算熔断 `EMAIL_DAILY_MAX` 默认 100）经 **通用 SMTP（nodemailer，`SMTP_*` 环境变量）** 投递；未配置 SMTP 时注册 503 `email_unavailable`、登录不受影响。移除 OTP 路由/hub-auth.js/challenge 映射；admin 定位键回 email；`/v1/admin/email-outbox`（test-only）作为邮件池供测试读码。镜像 **1.3.0** 已推送。
2. **主仓库**：客户端链路回到 login(email,password)/register(email,password,code) + sendEmailCode；UI 恢复邮箱+密码+验证码表单（保留倒计时/重发锁）。Windows 包需重打 local-test-8。
3. **文档**：ADR-0049 → Superseded 归档；ADR-0047 §19 恢复有效；新增 ADR-0051；权威矩阵/ops/CONTEXT/technical-overview/README 同步。
4. **生产实测教训沉淀**（ADR-0051 决策 4）：OPC OTP 发码对未录入身份假发送（与 purpose 无关），OpenID/LOGIN 两路线均无法开放注册；未来绑定 OPC 身份走 `account_identities` 扩展，不动登录主链。
