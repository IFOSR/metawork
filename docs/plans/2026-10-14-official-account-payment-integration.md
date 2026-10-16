# MetaWork 官方账号订阅支付与退款通道接入方案（OPC Hub / 微信 Native 扫码）

- 方案日期：2026-10-14
- 状态：已实施（本地）；huoshan 部署与真机扫码/退款演练验收待办。
- 确认依据：用户确认支付渠道仅微信 Native 扫码；退款通道本期全量接入但仅管理员/客服发起（Web 无退款入口、不限时间窗口、全额退款、成功后恢复购买前状态）；维持手动续费与"到期后可换购"现状；签名与接口字段以 OPC Hub 文档站（`https://opc-docs.dev.metafusion.cc/payments/`，含认证与签名、创建订单、预支付、查询订单、关闭订单、支付结果通知、退款四页、错误码页）为准精确实现。2026-10-14 外部评审（3 P0 / 6 P1 / P2）经逐条核验后全部采纳，其中 P1-10 定性纠正；同日第二轮外部评审（2 P1 / 5 P2）与第三轮评审（8 P2/nit）经核验后全部采纳；两轮自查补齐结算管线语义与意图行兜底边界。修订明细见 §10。
- 架构权威：[ADR-0048](../adr/0048-official-account-payment-settlement.md)（本方案接受为决策）；[ADR-0047](../adr/0047-account-license-and-official-ai.md)（账号授权与官方服务边界，除支付延后条款外全部维持）。
- 文档定稿日期：2026-10-14（含三轮评审、两轮自查与第四轮部署前评审修订）
- 实施完成日期：2026-10-14
- 交付验证：`official-server` `npm test` 22/22 通过（9 项既有回归 + 13 项支付/退款：签名规范串与文档示例、桩 Hub 端到端签名核验、回调幂等与重复回调不重复加时长、旧 attempt 迟到回调结算、双 attempt 重复支付 incident、close-已支付竞态反查、金额不符/未知单号/禁用账号 incident 台账、5s 轮询节流、二维码过期重开、查单对账回填 channel_order_no、意图行崩溃原键重放、判定表四分支、未配置支付 env 时行为不变与 503、非法 CLIENT_ID 启动失败闭合、**已结算行（paid）Hub 侧外部退款观测**（6/7 → incident + 行 refunded + 节流后不重触发 + 管理端退款 409）、**丢 notify 重复支付笔管理端退款**（对账先行结算 duplicate → 全链路成功））；主仓库 `tsc --noEmit` 通过（authorization/client/service/management 四处）+ 定向 vitest 通过（LocalAuthorizationService：payOrder 代次隔离、refreshOrder 已支付即 verify、payment_unavailable 不改权益态；OfficialServiceClient：六类错误码映射；management server：三条支付路由的 401/403/200/503 边界——1 项既有 Windows 环境失败与支付无关）；web `npm run build`（tsc + vite）通过（`qrcode` 已进 dependencies、`@types/qrcode` devDependencies）。
- 真实网关全链路（2026-10-14，`test/real-hub-smoke.mjs`，13/13 通过）：对 `https://opc-openapi.dev.metafusion.cc` 完成签名下单（¥9.90 订阅单，真实 order_no）、真实微信二维码预支付（`weixin://wxpay/...`）、查单、关单（状态 5）、未知订单 404、本地服务端到端（真实订单 + 真实二维码 + 对账 + 伪造签名 401 + 正确签名未知单 incident + 管理端真实关单 + 关单后支付 409）。未覆盖：真实扫码后的 `PAYMENT.PAID` 回调结算与退款（需真实支付；逻辑由桩测覆盖）。
- Docker 镜像测试未执行（本机无 Docker）；收尾提交：未创建提交，等待用户验证。

## 1. 目标与分层

打通月度（¥9.90）/年度（¥99.00）订阅的**真实支付**，并**全量接入退款通道**（接口、数据、终态对账、权益恢复内核），本期经管理端命令真实联调打通；未来若上线用户自助退款，只需新增 Web 路由 + 窗口/资格策略 + UI，复用同一内核，通道零改动。

| 决策点 | 结论 |
| --- | --- |
| 支付渠道 | 仅微信 Native（`channel:1`），Web/Desktop 展示二维码 |
| 退款 | 通道层本期接入；发起仅管理员/客服（SSH loopback 管理接口）；不限时间窗口（微信渠道侧对陈旧交易可能拒退，落 `manual_required` 人工路径）；全额退款；成功后恢复购买前权益状态 |
| 自动续费 | 维持手动续费（既有决策"不默认自动扣款"）；微信委托代扣待 OPC Hub 产品与资质具备后另立项 |
| 套餐变更 | 维持现状：持有生效套餐时跨套餐购买被 `active_plan_conflict` 拒绝，到期后可换购，零改动 |
| 签名与接口字段 | 按 OPC Hub 文档精确实现（见 §3、§4） |

**必须遵守的既有契约**（official-server/README.md、ADR-0047、2026-10-09 设计文档）：

1. 支付回调是权益开通的唯一授权依据；浏览器跳转、客户端自报不是。
2. 结算前核验交易、金额、币种、账号、订单；事务性去重；**重复回调不重复加时长**。
3. 有效期内同套餐续费从 `max(now, expiresAt)` 经 `addCalendarMonths`（`official-server/business.js` 已有）顺延；已过期、试用转付费、无权益从支付确认时间起算。
4. 价格由服务端定义；权益只能由官方服务授予；禁止管理员模拟付费。
5. **真实资金到账且无法正常结算的情形（关闭后到账、重复支付、金额不符、未知单号、禁用账号付款、下单后支付前被授予 `internal_perpetual` 的冲突）一律持久化为待对账事件（§3.3 `payment_incidents`），不得只留日志**。

## 2. 系统边界

```text
Web / Desktop（扫码支付入口）
        │  /api/official-auth/*（本机会话 cookie）
        ▼
本机 MetaWork Server（LocalAuthorizationService，仅透传与投影）
        │  HTTPS Bearer 官方会话
        ▼
MetaWork 官方服务（official-server，商户角色）
        │  HMAC-SHA256 签名（X-Client-Id/X-Timestamp/X-Nonce/X-Signature）
        ▼
OPC Hub 统一支付网关  ──▶ 微信支付（Native 扫码）
        │
        └── PAYMENT.PAID 回调 ──▶ 官方服务 /v1/payments/notify（验签 + 事务结算）
```

本地 MetaWork Server 与 Web 只透传和展示，不产生任何权益事实；退款不经过客户端。

## 3. official-server 后端（商户侧）

### 3.1 新模块 `official-server/hub-payments.js`（零依赖 ESM）

**出站签名**（按《认证与签名》文档）：

- 规范请求串 7 字段 `\n` 连接：`METHOD`（大写）、`PATH`（完整请求路径，含 `/v1` 前缀）、`QUERY`（原样百分号编码、不重排、无 `?`、无则空串）、`BODY_HASH`（raw body bytes 的 SHA-256 小写 hex，空体用常量 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）、`TIMESTAMP`、`NONCE`、`CLIENT_ID`。
- `X-Signature = hex(HMAC-SHA256(client_secret, 规范串))`，小写 64 位。
- 四头：`X-Client-Id`（32 位小写 hex）、`X-Timestamp`（Unix 毫秒字符串）、`X-Nonce`（每次 `randomBytes` 生成 32 位 hex，Hub 侧负责窗口内查重）、`X-Signature`。
- 请求体只序列化一次，哈希与发送使用同一份 bytes。
- 时间窗 300,000 ms；连接失败/超时映射 `payment_hub_unavailable`；连续签名失败输出告警日志 `payment_hub_clock_skew_suspected`（时钟漂移排查线索）。

**接口封装**（统一：签名四头、15s 超时、`redirect:'error'`、强制 HTTPS（测试环境豁免见 §3.7）、信封 `{code,message,request_id,timestamp,…}` 解析，`code!=="OK"` 携带 `OPC_*` 码抛 SafeError，429 尊重 `Retry-After` 单次重试后报 `payment_hub_busy`）：

| 函数 | 端点 | 关键字段 |
| --- | --- | --- |
| `createHubOrder({amountCents, description, notifyUrl, expireMinutes=30})` | `POST /v1/payments/orders` | body `{channel:1, purpose:2, amount_cents, description, expire_minutes, notify_url}`；不带 `project_id`/`open_id`；返回 `order_no`（32 hex）、`expire_time` |
| `prepayHubOrder(orderNo, idemKey)` | `POST /v1/payments/orders/{orderNo}/prepay` | 空 body；返回 `qr_code_url`（`weixin://wxpay/bizpayurl?pr=...`）；`OPC_PAY_ORDER_CANNOT_PREPAY` 触发重开 |
| `queryHubOrder(orderNo)` | `GET /v1/payments/orders/{orderNo}` | `status`（1 已创建/2 支付中/3 已支付/4 失败/5 已关闭/6 全额退款/7 部分退款）、`channel_order_no`（微信交易号）、`channel_paid_amount`（代金券后实付，可空）、`refunded_amount_cents`、`amount_cents` |
| `closeHubOrder(orderNo, idemKey)` | `POST /v1/payments/orders/{orderNo}/close` | 空 body；仅 1/2 状态可关；**失败时必须反查**：若因已支付关单失败（400 `OPC_PAY_ORDER_CANNOT_CLOSE`），返回已支付事实供结算 |
| `createHubRefund(orderNo, {amountCents, reason}, idemKey)` | `POST /v1/payments/orders/{orderNo}/refunds` | body `{amount_cents, reason}`（必填，≤200 字符）；返回 `refund_no`；错误含 `OPC_PAY_REFUND_EXCEEDS_ORDER_AMOUNT`、`OPC_PAY_ORDER_CANNOT_REFUND`、409（已全额退或存在异常单） |
| `processHubRefund(refundNo, idemKey)` | `POST /v1/payments/refunds/{refundNo}/process` | 空 body，通用响应 |
| `cancelHubRefund(refundNo, idemKey)` | `POST /v1/payments/refunds/{refundNo}/cancel` | 空 body；仅 `created` 状态可取消，400 `OPC_PAY_REFUND_CANNOT_CANCEL`；供管理端误操作撤回 |
| `queryHubRefund(refundNo)` | `GET /v1/payments/refunds/{refundNo}` | `status`（1 已创建/2 处理中/3 成功/4 失败/5 已关闭/6 异常）、`refunded_time`、`channel_refund_no`、`retry_count` |

**错误码归类**（按 errors 页核实；错误码映射集中本模块单处）：

| 归类 | 错误码 |
| --- | --- |
| 可重试（瞬时） | `OPC_STATE_IDEMPOTENCY_PROCESSING`（409，同一幂等键处理中，文档要求"复用原键稍后重试"）、`OPC_PAY_CHANNEL_UNAVAILABLE`（503）、`OPC_PAY_CHANNEL_ERROR`（502）、`OPC_SYS_SERVICE_UNAVAILABLE`（503）、`OPC_SYS_REDIS_UNAVAILABLE`（503，Hub 自述"fail-closed，请稍后重试"，属 Hub 侧瞬态）、`OPC_SYS_AUTH_DEPENDENCY_UNAVAILABLE`（503）、429 限流——前三类 SYS 码映射 `payment_hub_unavailable`，不得落成通用错误 |
| 签名/时钟（关联告警，不盲目重试） | `OPC_AUTH_INVALID_SIGNATURE`（401）、`OPC_AUTH_TIMESTAMP_OUT_OF_WINDOW`（401）、`OPC_AUTH_NONCE_REPLAY`（401）——连续出现关联 `payment_hub_clock_skew_suspected` 告警 |
| 凭证生命周期（fail-closed） | `OPC_AUTH_INVALID_CLIENT`（401）、`OPC_AUTH_CLIENT_EXPIRED`（401）、`OPC_AUTH_CLIENT_DISABLED`（403）——运行期出现即告警并停止支付调用，不可重试，需人工换凭证 |
| 实现 bug（显式暴露） | `OPC_IDEMPOTENCY_CONFLICT`（409）、`OPC_STATE_IDEMPOTENCY_CONFLICT`（409，同一幂等键提交到不同资源）——记 error 级日志并原样透出，不得静默重试 |
| 终态业务错误 | `OPC_PARAM_INVALID`、`OPC_PAY_ORDER_CANNOT_PREPAY`（400）、`OPC_PAY_ORDER_CANNOT_CLOSE`（400）、`OPC_PAY_ORDER_CANNOT_REFUND`（400）、`OPC_PAY_REFUND_CANNOT_CANCEL`（400）、`OPC_PAY_ORDER_ALREADY_PAID`（409）、`OPC_PAY_ORDER_EXPIRED`（400）、`OPC_PAY_ORDER_IDEMPOTENCY_MISMATCH`（409）、`OPC_PAY_AMOUNT_MISMATCH`（400）、`OPC_PAY_AMOUNT_TOO_SMALL/TOO_LARGE`（400）、`OPC_PAY_REFUND_EXCEEDS_LIMIT`（400）、`OPC_PAY_REFUND_EXCEEDS_ORDER_AMOUNT`（400）、`OPC_PAY_REFUND_ALREADY_EXISTS`（409）、`OPC_PAY_PROJECT_ID_REQUIRED`（400）、`OPC_PAY_PROJECT_FORBIDDEN`（403） |
| 资源不存在 | `OPC_RESOURCE_NOT_FOUND`（404，通用）、`OPC_PAY_ORDER_NOT_FOUND`（404）、`OPC_PAY_REFUND_NOT_FOUND`（404） |
| 回调侧 | `OPC_PAY_CALLBACK_INVALID_SIGNATURE`（401）、`OPC_PAY_CALLBACK_BODY_TOO_LARGE`（413，64KB 上限） |

未列入表的 `OPC_*` 码一律按终态错误上抛并记录 Hub `request_id`（fail-closed，不猜测重试语义）。

**入站通知验签**（按《支付结果通知》页）：`verifyNotifySignature(rawBody, headers)`——

1. `X-Timestamp` 偏差 ≤300,000 ms；
2. 规范串：METHOD=POST、PATH=**实际进入请求的路径**（`/v1/payments/notify`）、QUERY=''、BODY_HASH=sha256(raw body)、CLIENT_ID=**收到的 `X-Client-Id` 头值**；
3. 用本方 `client_secret` 重算，`timingSafeEqual` 比较；
4. `X-Client-Id` 与本方 client_id 的等式**只作软告警不硬拒**（文档未承诺该头必为商户本方 id；验签本身已由 client_secret 绑定），联调确认归属。

通知体 `{event_type:"PAYMENT.PAID", order_no, amount_cents, paid_time(UTC ISO), paid_time_epoch(Unix 秒)}`。**通知体没有交易号**，`channel_order_no` 由查单回填；业务时间只用 `paid_time_epoch`，站内 `"YYYY-MM-DD HH:MM:SS"`（北京时间）串仅存档。接收方返回任意 2xx 即收妥（Hub 不检查响应体）；失败重试 9 次（立即→15s→30s→2m→5m→30m→1h→2h→4h）后死信。`notify_url` 要求 HTTPS 公网、禁内网地址、不跟随重定向、≤512 字符。

### 3.2 `business.js` 纯函数（独立可测）

- `settlementExpiry({plan, paidAt, currentEntitlement})`：期内同套餐从 `max(now, expiresAt)` 顺延；过期/试用转付费/无权益从 `paidAt` 起算。
- `refundRestoreRevision(licenseHistory, refundedLicenseId)`：返回应追加的恢复 revision（复制前一 revision 的 plan/status/effective_at/expires_at；无前一 revision 则 `status='revoked'`）。
- `yuanToCents('9.90') → 990`、`centsToYuan(990) → '9.90'`：整数分与十进制串互转，全程整数运算，不碰浮点。
- `parseHubDatetime('2026-06-16 10:30:00')`：站内北京时间串按 **+08:00** 解析为 UTC ISO（仅用于过期判断启发与存档；业务计时以 `paid_time_epoch` 为准）。

### 3.3 Schema（新表；已部署库仅新增表，无 ALTER，重启即生效）

```sql
CREATE TABLE IF NOT EXISTS order_payments (
  hub_order_no TEXT PRIMARY KEY,              -- 32 hex；每次 attempt 一行，保留历史
  order_id TEXT NOT NULL REFERENCES orders(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,                       -- pending | paid | refunded | closed
  amount_cents INTEGER NOT NULL,              -- 990 / 9900
  currency TEXT NOT NULL,
  code_url TEXT,
  channel_order_no TEXT,                      -- 微信交易号，查单回填
  channel_paid_amount_cents INTEGER,          -- 代金券后实付，存档
  paid_at TEXT, settled_at TEXT,
  granted_license_id TEXT,                    -- 退款回滚锚点
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_payments_order ON order_payments(order_id, attempt);
CREATE TABLE IF NOT EXISTS order_refunds (
  id TEXT PRIMARY KEY,                        -- 本地生成；意图行先行（见 §3.6 崩溃窗口兜底）
  refund_no TEXT UNIQUE,                      -- 32 hex；Hub 返回前为 NULL
  idempotency_key TEXT NOT NULL UNIQUE,       -- refund-<orderId>-<attempt>
  order_id TEXT NOT NULL REFERENCES orders(id),
  hub_order_no TEXT NOT NULL REFERENCES order_payments(hub_order_no),
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,                       -- created | processing | succeeded | failed | closed | exception
  entitlement_restored INTEGER NOT NULL DEFAULT 0,
  manual_required TEXT,                       -- 非空=需人工的机器可读原因
  channel_refund_no TEXT, refunded_time TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_incidents (
  incident_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                         -- unknown_order | duplicate_payment | paid_after_closed_order
                                              -- | disabled_account_paid | amount_mismatch | external_refund_observed
                                              -- | perpetual_conflict（下单后支付前被授予 internal_perpetual，转人工退款）
  hub_order_no TEXT, order_id TEXT,
  detail TEXT,                                -- 脱敏摘要（金额分、事件类型；不含正文/密钥）
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS incident_open_unique ON payment_incidents(kind, hub_order_no) WHERE resolved = 0;
CREATE INDEX IF NOT EXISTS incident_open_list ON payment_incidents(resolved, created_at);
```

- `orders.status` 取值扩展：`pending_payment` → `paid` / `closed` / `refunded`。`entitlement()` 现有 pending 合成逻辑不受影响。
- `grant()` 修改为返回新 license id（`granted_license_id` 锚点必需，现函数无返回值）。
- 存量 `pending_payment` 订单天然兼容：金额与当前定价一致，可直接发起新通道支付。

### 3.4 支付路由（session 认证）

- `POST /v1/orders/{orderId}/pay`（own 订单、限 monthly/annual、限 `pending_payment`）：无在途 Hub 单则 `createHubOrder`（Idempotency-Key=`pay-<orderId>`，连字符格式）→ `prepay` → 返回 `{order, payment:{status, qrCodeUrl, expiresAt}}`；不可预支付/已过期 → 旧单 best-effort `closeHubOrder` + `attempt+1` 重开（键 `pay-<orderId>-a<n>`）。**并发双发 /pay**：Hub 幂等返回同一 `order_no`，本地插入用 `ON CONFLICT(hub_order_no) DO NOTHING` 后回读，避免主键冲突 500。限流 10/min/账号。
- `GET /v1/orders/{orderId}`（own）：订单+支付状态；本地行存在 `pending`/`paid`（未结或已结算）时**逐行**节流查单对账（兜底路径；Hub 无退款回调，`paid` 行同样依赖轮询发现平台侧外部退款）：Hub status=3 且行 `pending` 就地结算，4/5 且行 `pending` 标该行 closed；**Hub status=6/7 且行为 `pending`/`paid`**（平台侧外部退款；行已 `refunded` 后不再触发，状态守卫 + 部分唯一索引双重防重）→ 落 `payment_incidents`（`external_refund_observed`，`INSERT OR IGNORE`）+ 行标 `refunded`，权益与订单状态交人工裁决；人工判定退款未发生而保持行 `paid` 时，轮询会持续再告警（行状态与 Hub 事实不一致即应持续响）。**节流**：按 hub_order_no 借用 `rates` 结构维护 Hub 查询最小间隔 5s 标记，命中间隔**直接返回本地状态而非抛 429**——notify 是主通道，轮询只是兜底，避免 Web 4s 轮询放大打爆 Hub 限流。
- `GET /v1/orders`（own）：own 订单列表（最近 50 条），供 UI 找回待支付订单。
- `POST /v1/payments/notify`（公网，验签如 §3.1）：原始 body（64k 上限）→ 验签 → `event_type==="PAYMENT.PAID"` 按 `hub_order_no` 定位 `order_payments` 行（**含历史 attempt**）→ 事务结算。**响应顺序**：结算成功或判定永久忽略（含落 `payment_incidents`）才返回 2xx；瞬时 DB 错误返回 5xx 交给 Hub 重试（9 次递增至死信）；验签失败 401。免用户 IP 限流（网关重试不能被限流打死）。

### 3.5 支付结算 `settlePayment`（事务内幂等核心）

**守卫按 MetaWork 订单状态判定，不按 attempt 行状态**（attempt 行 closed 不阻断结算——关单与支付的竞态下钱仍属本订单）：

1. `BEGIN IMMEDIATE`；**事务内只做本地读写，零网络 I/O**（`DatabaseSync` 为同步 API，事务内外呼会以同步方式阻塞整个事件循环，令全站停摆并拖超时 notify 触发 Hub 重投）；
2. 该 attempt 行 `settled_at` 已置 → **幂等直接返回**（同一 attempt 的重复回调，含 Hub 9 次重投；先于一切状态判定）；
3. 目标 MetaWork 订单为 `pending_payment` → **进入结算管线**（含 attempt 行为 `closed` 但实际已支付的情形：close 竞态输给支付，钱仍归属本订单）：管线为第 6 步金额校验 → 第 7 步账号校验 → 第 8 步落账；
4. 父订单已 `paid` 且到账的是**另一 attempt** → 该 attempt 行**置 `paid`**（Hub 事实；该行原本是 `pending`），duplicate 标记落 `payment_incidents`，**权益只发一次**，转人工退款（终态分流，不进管线）；
5. 父订单已 `refunded`/`closed` → attempt 行**置 `paid`**（Hub 事实），落 `payment_incidents`（`paid_after_closed_order`），转人工退款，**不得静默返回**（终态分流，不进管线）；
6. 管线校验一：`amount_cents === yuanToCents(orders.amount_cny)`（订单价为准；`channel_paid_amount` 仅存档）不符 → attempt 行**置 `paid`**，落 `payment_incidents`（`amount_mismatch`）+ 日志，管线终止，不授益；
7. 管线校验二：账号已禁用 → attempt 行**置 `paid`**，落 `payment_incidents`（`disabled_account_paid`），管线终止，转人工退款；
7b. 管线校验三：支付进行中账号被授予 `internal_perpetual`（免费权益与真实付款冲突）→ attempt 行**置 `paid`**，落 `payment_incidents`（`perpetual_conflict`），管线终止，转人工退款；
8. 校验通过 → 落账：`orders.status='paid'`、attempt 行 **`status='paid'`**、`paid_at`（epoch→ISO）、`settled_at`、`grant()` 取 license id 回填 `granted_license_id`。
   第 4–7 步互斥，按父订单状态与校验结果分流，命中即止；所有 `payment_incidents` 写入用 **`INSERT OR IGNORE`**（依赖 §3.3 部分唯一索引按 kind+hub_order_no 去重）；
9. `COMMIT` 之后（**事务外**）：同单其他在途 attempt best-effort 关闭；close 失败且反查已支付 → 对该 attempt **独立重入本结算流程**（第 2 步幂等 + 第 4 步 incident 去重保证重入一致）。§3.5 的 incident 路径（第 5/6/7 步）置行 `paid` 后即满足 §3.6 退款前置，incident 资金全程可经管理端退款通道退回。

**v1 边界语义（写入 ADR-0048）**：试用转付费立即生效、试用剩余天数作废；被撤销（未禁用）账号可重新订阅并生效；禁用账号付款到账转人工退款；重复支付不自动退款，标记后由管理员经退款通道处理。

### 3.6 退款通道（内核 + 管理端触发）

**内部接缝（未来自助功能复用）**：`initiateRefund(orderId, hubOrderNo, actor)`（`hubOrderNo` 缺省 = 当前生效 license 对应 attempt，显式传入用于 duplicate 多笔场景）、`reconcileRefund(refundNo)`、恢复内核 `refundRestoreRevision`。

- `initiateRefund`：先支付对账（**无条件**：Hub 已付而本地未结 → 先结算，丢失 notify 的重复支付笔即可直达；Hub 6/7 → 行标 `refunded` + `external_refund_observed` incident + `already_refunded` 409）→ 校验目标 attempt 为 `paid` 且无进行中退款（§3.5 incident 路径已把全部真实到账行置 `paid`，本前置对 incident 资金同样可达）→ **先落意图行**（本地 `id`、`idempotency_key`=`refund-<orderId>-<attempt>`、`refund_no` 为 NULL、`status='created'`）→ `queryHubOrder` 计算可退金额 `= (channel_paid_amount ?? amount_cents) − refunded_amount_cents` → `createHubRefund`（金额固定全额）回填 `refund_no` → 紧接 `processHubRefund`。**崩溃窗口由幂等键兜底**：create 成功与本地回填之间崩溃会留下无 `refund_no` 的意图行，sweep 用原键重放 `createHubRefund`（Hub 幂等返回既有退款单）回填，不会产生第二笔退款。
- 管理端路由（loopback + ADMIN_TOKEN，与现有 `/v1/admin/*` 同防护，**全部为 POST**——现有 `adminRoute` 对非 POST 一律 405，无需放宽）：
  - `POST /v1/admin/refunds` `{orderId, hubOrderNo?, reason}`；
  - `POST /v1/admin/refunds/query` `{refundNo}`：拉终态并对账落库；
  - `POST /v1/admin/refunds/cancel` `{refundNo}`：取消尚在 `created` 的退款单（`OPC_PAY_REFUND_CANNOT_CANCEL` 400 为终态）；
  - `POST /v1/admin/orders` `{email}`：客服查账（订单+支付+退款状态）；
  - `POST /v1/admin/orders/close` `{orderId}`：关闭待支付单。
- `admin.js` 子命令：`orders <email>`、`refund <orderId> [hubOrderNo] <reason...>`（第二参数匹配 32 位 hex 时解析为 `hubOrderNo`，其余参数 join 为 `reason`——客服原因文本不会是 32-hex，误判率≈0）、`refund-status <refundNo>`、`close-order <orderId>`（对应 `POST /v1/admin/orders/close`）、`incidents [--resolve <id>]`（未决清单直读 `payment_incidents`；人工处理完成后置 `resolved=1`，退款成功对账路径自动置位）。
- **终态处理**：admin 查询惰性对账 + 每 60s 轻量 sweep（`refund_no` 为空的意图行**不限年龄**用原幂等键重放 `createHubRefund` 回填——数量小且是崩溃兜底，直至回填；`created`/`processing` 限近 7 天：`created` 补发 `processHubRefund`，`processing` 拉 Hub 终态；`OPC_STATE_IDEMPOTENCY_PROCESSING` 归可重试）：
  - Hub 3（成功）→ **有序判定表**（按序命中即止，谓词互斥）：

    | 序 | 判定 | 处置 |
    | --- | --- | --- |
    | 1 | 退款目标 attempt 的 `granted_license_id` 仍是账号当前生效 revision | 按 `refundRestoreRevision` 追加恢复 revision、`entitlement_restored=1`、attempt 行 `refunded`、**且仅此时** `orders.status='refunded'` |
    | 2 | attempt 有锚点但存在更新 revision（锚点非当前生效） | 权益与 `orders.status` 不动（保持原状 `paid`）、attempt 行 `refunded`、`manual_required='newer_revision_exists'` |
    | 3 | duplicate attempt（无锚点，关联 `duplicate_payment` incident） | 权益与 `orders.status` 不动（保持原状 `paid`）、attempt 行 `refunded`、关联 incident 置 `resolved=1`、`manual_required='duplicate_attempt_refunded'` |
    | 4 | incident 驱动（无锚点：`paid_after_closed_order`/`amount_mismatch`/`disabled_account_paid`） | 权益本就未授无需恢复、attempt 行 `refunded`、关联 incident 置 `resolved=1`、父订单仍 `pending_payment` 的置 `closed`（禁用账号场景），其余父订单保持原状 |

    退款成功对账同时将关联 `payment_incidents` 自动置 `resolved=1`；
  - Hub 4/5 → 落库，权益与订单状态保持原状。**Hub 4（退款失败）为该退款单终态**（cancel 仅对 `created` 状态合法，不可取消已失败单）；确需重退时管理员再次发起，幂等键带重试序号 `refund-<orderId>-<attempt>-r<n>`，同样意图行先行，失败单保留为审计；
  - Hub 6（异常）→ `manual_required='hub_exception'`，同步落 `payment_incidents`；
  - `duplicate_payment` 单经 `initiateRefund(orderId, hubOrderNo)` 走同一退款内核人工触发。

### 3.7 配置 `.env.example` + 启动校验

```text
PAYMENT_HUB_BASE_URL=          # 生产 https://opchub-openapi.metafusion.cn（联调用 https://opc-openapi.dev.metafusion.cc）；强制 HTTPS、禁 userinfo/query（同 MODEL_BASE_URL 规则）
PAYMENT_HUB_CLIENT_ID=         # 32 位小写 hex，启动校验格式
PAYMENT_HUB_CLIENT_SECRET=
PAYMENT_NOTIFY_URL=            # 如 https://14.103.216.193:9222/v1/payments/notify
PAYMENT_CHANNEL=wechat_native
```

- `PAYMENT_HUB_BASE_URL` 校验**复刻 MODEL_BASE_URL 豁免**：`NODE_ENV==='test'` 时允许 `http://127.0.0.1`（server.js:14 同款），否则桩 Hub 测试无法驱动。
- `PAYMENT_NOTIFY_URL` 为空时创建订单不带 `notify_url`，仅靠轮询对账（可用但依赖用户停留页面）。
- 全部未配置 → 支付/退款关闭，现有行为不变，`/pay` 返回 503 `payment_unavailable`（支持先发码后配密钥的平稳发布）。
- nginx：`/v1/payments/notify` 走现有 `location /` 代理即可；确认不记录请求体（现状已满足）。

## 4. 本地客户端链路（主仓库，仅支付）

- `src/authorization/types.ts`：`OfficialOrder`/`OfficialPaymentView`（`qrCodeUrl`、`expiresAt`、`status`）；错误码增 `payment_unavailable`。**`expiresAt` 由官方服务以 ISO UTC 下发**（服务端出参前经 `parseHubDatetime` 归一），客户端不做本地时区推断。
- `src/authorization/official-service-client.ts`：`payOrder/getOrder/listOrders`（Bearer 会话、zod 校验）；**错误码映射表**（新增）：`payment_unavailable`（503 支付关闭/渠道不可用）、`payment_hub_busy`（429/`OPC_STATE_IDEMPOTENCY_PROCESSING`/Hub 不可达，服务端出口经 `presentHubError` 统一翻译后透出为"处理中请稍候"）、`payment_order_expired`（`OPC_PAY_ORDER_EXPIRED`）、`payment_order_state_conflict`（`OPC_PAY_ORDER_ALREADY_PAID`/`CANNOT_PREPAY`）、`payment_refund_*`（管理端专用，不经客户端）、既有 `session_invalid`/`verification_unavailable` 语义不变。
- `src/authorization/local-authorization-service.ts`：代次隔离的 `payOrder()/refreshOrder()`；确认已支付后立即 `verifyForProduction()`（现有钩子，支付成功即时刷新，不等 24h 周期）。
- `src/management/server.ts handleOfficialAuth`：`POST /api/official-auth/orders/:id/pay`、`GET /api/official-auth/orders/:id`、`GET /api/official-auth/orders`，沿用 cookie 认证 + 现有错误映射 + `no-store`。
- 权益翻转后无需改准入：`newWorkAdmission`/`productionAuthorization`/`allowsKernelAction` 均读投影，自动解阻；TUI/飞书同步生效。

## 5. Web UI（Desktop 自动继承）

`web/src/components/OfficialAccountPanel.tsx`：

1. 选月/年套餐 → 创建订单 → 立即调 pay → 弹窗将 `qrCodeUrl`（`weixin://…` 字符串）用 `qrcode` 渲染成二维码图片——**新增到 `web/package.json` 的 `dependencies`**（Vite 客户端产物需要，不得放 devDependencies）；
2. 弹窗打开期间每 4s 轮询 `GET orders/:id`（服务端已做 Hub 查询节流，见 §3.4）；`paid` 后停止、提示成功、触发 verify，投影翻 active；
3. 二维码过期（`expiresAt`）自动重开，上限 3 次后转为手动"刷新二维码"按钮；
4. 套餐区下增加待支付订单"继续支付"入口；移除"支付接入尚未开放"文案；脚注提示"退款请联系客服"。

## 6. 测试

`official-server/test/service.test.js`（沿用"桩上游 + 子进程真服务 + 直查 SQLite"模式，新增桩 Hub 服务器，报文按文档示例）：

- **签名**：按文档示例向量验证 `sign()`（GET 带 query、POST 带 body、空 body 常量）；桩 Hub 重算规范串核对四头；错误时间戳/篡改 body 拒绝；连续签名失败触发时钟漂移告警；通知验签通过/篡改 401；`X-Client-Id` 非本方 id 时验签仍通过且出软告警。
- **支付**：下单/预支付字段与幂等键正确；回调按 `hub_order_no` 定位历史 attempt 行；**旧 attempt 迟到回调正常结算**；**重复回调不重复加时长**；**同一 attempt 重复回调幂等直接返回**；**双 attempt 重复支付 → 单次权益 + `duplicate_payment` incident**；**closed attempt 到账但父订单 pending → 正常结算**（close 竞态）；**父订单已 closed/refunded 时到账 → `paid_after_closed_order` incident 而非静默**；**未知 hub_order_no → incident 持久化**；**禁用账号付款 → incident**；金额不符 → `amount_mismatch` incident；close-已支付竞态 → 反查结算；**事务内外呼边界：sibling 关闭在 COMMIT 后发起，notify 响应不被 Hub 外呼阻塞**；**并发双发 /pay → `ON CONFLICT` 回读无 500**；Hub 6/7 对账且行仍 `pending`/`paid` → `external_refund_observed` incident；行已 `refunded` 不再触发；`paid_time_epoch` 解析；查单对账就地结算（含 `channel_order_no` 回填）；**轮询节流**（5s 间隔内不重复请求 Hub）；二维码过期 → 关单重开 attempt+1；未配支付 env 时 `/pay` 503 且下单行为不变；`PAYMENT_HUB_BASE_URL` 测试豁免生效。
- **退款**：可退金额计算（含代金券场景）；先对账后退款；`initiateRefund` 显式 hubOrderNo 定位 duplicate 笔；终态成功 → 恢复购买前 revision（试用恢复、无前置权益时 revoked）**且此时才置 `orders.status='refunded'`**；**duplicate attempt 退款成功 → 行 `refunded` 且权益与订单状态保持 paid**；存在更新 revision → 不自动动权益且标 `manual_required`；**判定表四分支互斥（duplicate 行无锚点不误入 incident 分支）**；**`created` 卡单 sweep 自动补发 process**；`OPC_STATE_IDEMPOTENCY_PROCESSING` 归可重试；cancel 仅 `created` 可取消；**Hub 4 终态后重退走重试序号新键，失败单保留审计**；失败/异常/重复支付单人工路径；sweep 命中；**意图行崩溃后原键重放回填 `refund_no` 且不产生第二笔退款**；**incident 驱动退款全链路**（行已置 `paid` → 退款成功 → 行 `refunded` + incident `resolved` + 父订单 `pending_payment` 置 `closed`）；同 kind 重复 notify 不产生第二行 incident（部分唯一索引）。
- 主仓库：LocalAuthorizationService/management 路由针对性 vitest（代次隔离、支付成功即刷新、错误码映射）；Windows 主机跑 `npm run lint`；official-server `npm test` 与 Docker 测试镜像。
- **交付状态（2026-10-14 部署前评审后）**：主仓库定向 vitest 已交付（见"交付验证"）。official-server 侧 §6 清单中**已由桩测覆盖**：签名规范串/桩 Hub 端到端验签、回调幂等、迟到/重复回调、双 attempt 重复支付、close 竞态、金额不符/未知单号/禁用账号 incident、节流、过期重开、崩溃原键重放、判定表 1–3 行、未配置 503、paid 行外部退款观测、丢 notify 重复支付笔退款。**暂缓**（逻辑存在、由真实网关 smoke 或后续补测覆盖，不阻塞部署）：篡改 body/错误时间戳验签单测断言、时钟漂移软告警断言、代金券场景可退金额、Hub 4 终态重退序号新键、sweep（created 补发/IDEMPOTENCY_PROCESSING）、cancel 仅 created、判定表第 4 行禁用账号父订单 pending→closed、admin.js CLI 参数解析。

## 7. 文档交付

- 新增 `docs/adr/0048-official-account-payment-settlement.md`：结算归属、回调权威、幂等规则、退款通道分层（通道层本期接入、业务层仅管理端、未来自助只加策略层）、恢复购买前政策、v1 边界语义（试用转付费立即生效、撤销后可重订阅、禁用账号付款/重复支付/关闭后到账转人工退款）、**退款后权益降级的生效时序**：新生产性请求在线核验即时阻断（ADR-0047），24h 后台核验仅影响已开跑工作的收尾节奏，与订阅到期/撤销的既有降级行为一致；手动续费与到期换购维持现状；登记 `docs/adr/README.md` 权威矩阵与 `docs/README.md` 导航。
- 本计划文档实施后回填"实施完成日期/交付验证/收尾提交"。
- 更新 `official-server/README.md`（结算已实现 + 新 env + admin 退款命令）、`docs/current/official-account-operations.md`（运行行为、部署步骤、退款人工路径）、`docs/current/technical-overview.md`（官方账号授权节同步支付/退款事实，AGENTS.md 工作规则要求）、`CONTEXT.md` 官方账号段落。

## 8. 实施顺序

1. official-server：schema + `hub-payments.js`（签名/验签/接口封装/错误码归类）+ 结算 + 支付路由 + notify + 测试；
2. official-server：退款通道（内核 + admin 路由 + admin.js + sweep + incidents + 测试）；
3. 主仓库客户端链路 + 测试；
4. Web UI 二维码与轮询；
5. 文档/ADR；
6. 部署：huoshan 配置支付 env（服务器 `.env`，权限 600）→ `systemctl restart metawork-official` → 真机扫码验收（支付开通、重复回调、断网补单、二维码过期重开、到期阻断解除）→ 管理端退款演练（权益恢复、duplicate/异常单人工路径）。

## 9. 待提供与已记录的平台事项（部署阶段）

- OPC Hub 商户凭证：`PAYMENT_HUB_CLIENT_ID` / `PAYMENT_HUB_CLIENT_SECRET` **按环境隔离**；生产凭证部署时经 K8s Secret 注入，不经手、不入库、不进代码。
- **API 域名分环境，凭证不通用**（2026-10-14/15 真实环境验证）：生产网关 `https://opchub-openapi.metafusion.cn`（部署配置目标，用户指定）；测试网关 `https://opc-openapi.dev.metafusion.cc`（测试凭证有效，全链路 13/13 通过）。凭证按环境隔离，生产凭证部署时经 Secret 注入。`opchub.dev.metafusion.cc` 是门户站点（POST 一律 405）；`opchub-openapi.metafusion.cn` 是 Hub 自己的生产域名（DNS 指向 Hub），**不可**用作我方回调域名。
- **notify_url 必须是域名**：真实 Hub 以 `OPC_PARAM_INVALID` 拒绝 IP 字面量 `https://14.103.216.193:9222/...`（真实环境已验证）。部署前需为回调准备解析到该主机的域名（或在平台侧登记白名单），nginx 按现有 `/v1/*` 代理即可。
- 已记录：文档最低金额两页不一致（创建订单页"最低 1 分" vs 错误码页 `OPC_PAY_AMOUNT_TOO_SMALL` "100 分/1 元"），本方案 990/9900 在任一口径下均安全；微信渠道对陈旧交易的退款时限由平台/渠道掌握，超时拒退落 `manual_required` 人工路径；Hub 幂等键字符集未在文档明示（示例仅见字母数字与连字符），实现层对 `pay-<orderId>` / `refund-<orderId>-<attempt>` 等键做 sanitize（去除字母数字与连字符以外字符）并保持唯一，联调确认——真实环境已接受 sanitize 后的键。

## 10. 评审修订记录（2026-10-14）

外部评审 3 P0 / 6 P1 / P2 共 13 项，逐条核验后全部采纳；其中 1 项定性纠正：

| # | 级别 | 修订 |
| --- | --- | --- |
| 1 | P0 | `initiateRefund` 增加 `hubOrderNo` 参数（缺省=当前生效 attempt），管理端路由/命令显式定位退款笔，避免 duplicate 场景退错笔 |
| 2 | P0 | 终态规则条件化：仅 `entitlement_restored=1` 时置 `orders.status='refunded'`；duplicate attempt 退款与 newer_revision 分支保持 `paid` + `manual_required` |
| 3 | P0 | 消除静默丢款：结算守卫改为按 MetaWork 订单状态判定（closed attempt 到账且父订单 pending → 正常结算）；父订单终态后到账、未知单号、金额不符、禁用账号付款一律落 `payment_incidents` 持久化待对账（§3.3/§3.5） |
| 4 | P1 | Hub 查询按单节流 5s，notify 主、轮询兜底，防 Web 4s 轮询放大触发 Hub 429（§3.4） |
| 5 | P1 | sweep 扩到 `created`+`processing`，`created` 自动补发 process；`OPC_STATE_IDEMPOTENCY_PROCESSING` 归可重试（§3.6，errors 页已核实该码） |
| 6 | P1 | 补 `cancelHubRefund` 与管理端取消路由（§3.1/§3.6） |
| 7 | P1 | admin 查账改为 `POST /v1/admin/orders`，规避现有 `adminRoute` 非 POST 一律 405（server.js:154），不放宽方法检查（§3.6） |
| 8 | P1 | 通知验签 `X-Client-Id` 等式降为软告警，头值参与规范串重算，联调确认归属（§3.1） |
| 9 | P1 | `PAYMENT_HUB_BASE_URL` 复刻 `NODE_ENV==='test'` 的 HTTP 豁免，桩 Hub 可驱动（§3.7） |
| 10 | P1（纠正） | 评审"退款后权益降级最长 24h 才发现"定性有误：ADR-0047 每次新生产性请求在线核验，下一新请求即时阻断；24h 仅影响已开跑工作收尾，与到期/撤销既有降级一致。仍按建议写入 ADR-0048 管理客服预期（§7） |
| 11 | P2 | `qrcode` 进 `web/package.json` `dependencies`（非 devDependency）（§5） |
| 12 | P2 | `expiresAt` 由服务端归一为 ISO UTC 下发（+08:00 解析集中在 `parseHubDatetime`）；错误码映射表按 errors 页补全；§7 补 `technical-overview.md`（§3.2/§4/§7） |
| 13 | P2 | 记录金额下限两页矛盾、微信陈旧交易退款渠道限制、notify_url IP 字面量登记确认（§9） |
| 14 | 自查#2 | 第二轮整体自查修订：同一 attempt 重复回调显式幂等返回（先于状态判定）；退款意图行先行 + 崩溃后原幂等键重放回填（不产生第二笔退款）；`payment_incidents.resolved` 置位规则（退款对账自动置位 + admin 手工置位）；duplicate attempt 行状态措辞（保持 `paid`，Hub 事实）；Hub 幂等键字符集 sanitize 备注（§3.3–§3.6、§9） |
| 15 | 评审#2 | 第二轮外部评审（2 P1 / 5 P2）全部采纳：① incident 路径（§3.5 第 5/6/7 步）同步置 attempt 行 `paid`，打通 incident 资金的管理端退款准入，退款成功后父订单 `pending_payment` 置 `closed`；② 事务内零网络 I/O——sibling 关闭移到 COMMIT 之后，反查已支付独立重入结算（`DatabaseSync` 同步阻塞事件循环，原设计会致全站停摆）；③ 并发双发 /pay `ON CONFLICT` 回读；④ 错误码补 AUTH 签名族/凭证族、`IDEMPOTENCY_CONFLICT`、SYS 族（errors 页逐码核实）；⑤ 状态机措辞（"置 paid"非"保持 paid"）、incident 部分唯一索引、Hub 6/7 对账 `external_refund_observed`、admin.js 32-hex 参数解析、FK 与清单索引（§3.1、§3.3–§3.6、§6） |
| 16 | 评审#3 | 第三轮外部评审（8 P2/nit）全部采纳：① §3.6 Hub 3 终态改**有序判定表**（四行互斥，分支 (b) 补 attempt 行 `refunded`）；② 6/7 对账改状态守卫（行 `pending`/`paid` 才触发；结案后不重开，人工判定未退款持续告警）；③ incident 插入显式 `INSERT OR IGNORE`；④ §3.5 第 4–7 步互斥说明；⑤ 错误码表补 `OPC_RESOURCE_NOT_FOUND`（已核实）+ 未列码 fail-closed 兜底句；⑥ Hub 4 终态 + 重退走重试序号新键（cancel 不适用终态）；⑦ `close-order` CLI 子命令；⑧ 判定表消除 (c) 谓词与 duplicate 重叠（§3.1、§3.3–§3.6） |
| 17 | 自查#3 | 最终深查修订：§3.5 结算流重述为"管线"语义——第 6/7 步是第 3 步管线内的校验（校验失败管线终止），第 4/5 步是终态分流（不进管线），消除上轮补丁引入的"4–7 步并列分流"歧义；sweep 对无 `refund_no` 意图行的重放**不限年龄**直至回填（崩溃兜底不受 7 天窗口约束），`created`/`processing` 维持 7 天（§3.5、§3.6） |
| 18 | 评审#4 | 第四轮部署前评审（2 P1 / 6 P2 / nit）全部采纳：① **外部退款盲区闭合**——`orderDetailView` 对账从仅 `pending` 行扩展为**逐行遍历 `pending`/`paid`**（Hub 无退款回调，paid 行是已结算单发现平台侧外部退款的唯一通道），6/7 → incident + 行 `refunded`（§3.4）；② 主仓库支付链路补定向 vitest（payOrder 代次隔离、refreshOrder 已支付即 verify、payment_unavailable 不改权益态、client 六类错误码映射、management 三条路由 401/403/200/503），交付验证同步补记（§6）；③ 服务端出口新增 `presentHubError` 翻译层，`payment_hub_busy`/`payment_order_expired`/`payment_order_state_conflict` 三个客户端分支不再是死代码，`payment_hub_unreachable` 归一为 `payment_hub_busy` 503（§4）；④ 通知验签 `X-Client-Id` 不等式补 `payment_notify_client_id_mismatch` 软告警日志（§3.1）；⑤ `perpetual_conflict` incident 回填 §1 契约 5/§3.3 kind 清单/§3.5 管线校验三与 ADR-0048 决策 8；⑥ `initiateRefund` 对账前置改**无条件**且先对账后守卫（丢失 notify 的重复支付笔可直接管理端退款；Hub 6/7 → 行 refunded + incident + 409），补两条桩测（§3.6）；⑦ §6 补交付状态注记（已覆盖 vs 暂缓清单） |
