# MetaWork 官方服务

账号、会话、套餐、待支付订单和固定内置 AI 业务接口共用 Node 22.19+ / SQLite。运行入口 `npm ci --omit=dev --ignore-scripts && npm start`，配置见 `.env.example`。`ADMIN_TOKEN` 必须是至少 32 字符的随机秘密，`.env` 权限 600；不要提交真实配置和数据库。

现部署于 `huoshan:/root/metawork-offical-server/`，systemd 单元 `metawork-official`，监听 loopback 8780。公网 HTTPS 入口 `https://14.103.216.193:9222/`，代理配置见 `deploy/nginx.conf`，管理路径在 nginx 被拒绝。Kubernetes 部署（生产镜像 + 单副本 SQLite 拓扑清单）见 [`deploy/k8s/README.md`](deploy/k8s/README.md)。

2026-10-10 按用户要求简化内置 AI：只配置模型地址、Key 和 Model ID，生成参数使用供应商默认值。`MODEL_THINKING` 和 `AI_DAILY_GLOBAL_LIMIT` 已删除；修改模型配置后重启 `metawork-official.service`，客户端无需重装。

公开接口：

- `POST /v1/auth/email/code`、`POST /v1/auth/register { email, password, code }`：邮箱注册（ADR-0050）。发码向邮箱投递 6 位验证码（15 分钟有效、5 次尝试上限、同邮箱重发作废旧码），注册须携带验证码，成功即邮箱已验证；经通用 SMTP（nodemailer）投递，`SMTP_*` 未配置时返回 503 `email_unavailable`。
- `POST /v1/auth/login`、`GET /v1/auth/session`、`POST /v1/auth/logout`：邮箱+密码登录（原体系，ADR-0047）。
- `GET /v1/entitlement`、`GET /v1/plans`、`POST /v1/orders`。
- `GET /v1/orders`、`GET /v1/orders/{id}`、`POST /v1/orders/{id}/pay`、`POST /v1/payments/notify`：订阅支付（ADR-0048）。pay 惰性创建 OPC Hub 订单并预支付返回 `qr_code_url`；GET 就地与 Hub 对账（按单 5 秒节流）；notify 为网关回调，HMAC 验签 + 事务结算 + 幂等，免 IP 限流。结算只信回调与查单事实，金额按订单价整数分校验，重复回调不重复加时长，无法结算的真实资金落 `payment_incidents` 人工对账。
- `POST /v1/ai/operation`：固定 operation、requestId、input。提示词由 `prompts.js` 按 operation 选择，输入作为业务数据传入，模型返回的 JSON 交给本地设置消费者解释。
- `POST /v1/runtimes`、`GET /v1/runtimes/{id}`、`GET /v1/runtimes`：实例（托管 Runtime 工作负载）创建与查询，方案见 `docs/plans/2026-11-09-official-runtime-provisioning-design.md`。创建需有效权益（402），幂等键按账号隔离，一账号仅一个活跃实例（409 `sandbox_exists`）；服务端经 in-cluster ServiceAccount 在 `nexusfusionai` namespace 顺序创建 PVC → Deployment → VPA → Service → Ingress 并等待就绪（响应含 `steps` 六步进度与专属域名 `<slug>.metawork.nexusfusionai.com`）。任一步失败回滚已建资源并落 `failed`（不占名额可重建）；服务重启打断的 provisioning 由确定性命名 get-or-create 续跑。生命周期：权益失效超宽限（默认 1 天）→ 停机 `suspended`（scale 0，PVC 保留）；续费后查询即重启同一实例（数据/域名不变）；停机超 30 天或 running 30 天无本人查询 → 标记 `recycle_pending`，不自动删除；删除仅经 SSH loopback 管理入口 `admin.js runtimes close`。
- `POST /v1/runtimes/{id}/access-url`、`GET /v1/runtime-access/{redeem,verify}`、`POST /v1/runtime-access/session`（免密登录）：access-url 返回一次性钥匙链接（默认 60 秒，绑定账号+实例+域名）；打开后兑换长期门票 Cookie（HttpOnly+Secure，随 revoke/access_generation 失效）并由实例 Runtime 自动采纳官方会话（免密码登录、权益在线核验刷新）。除 `/_auth/redeem` 外全部实例路径经 nginx auth-url 门禁（无门票 401）。`RUNTIME_IMAGE` 未配置时创建返回 503 `instance_unavailable`；其余 `RUNTIME_*` 键均有缺省值。

订单 `idempotencyKey` 长度 8–128，使用字母、数字、下划线或连字符。键按账号隔离，重复请求不得换套餐。试用七天，仅一次。月/年订单经 OPC Hub（微信 Native 扫码）真实结算：期内同套餐续费从 `max(now, expiresAt)` 按 `addCalendarMonths` 顺延，过期/试用转付费从支付确认时间起算；结算须核验交易、金额、币种、账号和订单，事务性去重。退款通道本期完整接入但仅管理员/客服发起（全额退、不限窗口、成功后恢复购买前权益状态；存在更新 revision 或 duplicate 笔时保持权益并标记人工），Web/TUI/飞书不出现退款入口。变更套餐另行定义。未配置 `PAYMENT_HUB_*` 时支付与退款关闭，行为与未接入一致。

管理命令（SSH 后使用；账号以 `email` 定位；`refund` 第二参数匹配 32 位 hex 时解析为 hub 订单号，其余为原因）：

```sh
node admin.js orders <email>                      # 查账：订单 + 支付/退款状态
node admin.js refund <order-id> [hub-order-no] <reason>
node admin.js refund-status <refund-no>
node admin.js close-order <order-id>              # 关闭待支付订单
node admin.js incidents [--resolve <incident-id>] # 未决支付 incident 台账
node admin.js runtimes                            # 实例台账：suspended/recycle_pending/failed
node admin.js runtimes close <sandbox-id>         # 人工确认后删除实例全部 K8s 资源（含 PVC）
```

内部永久权益与禁用操作（账号由用户完成邮箱验证码注册后创建）：

```sh
ssh huoshan
cd /root/metawork-offical-server
node admin.js grant-perpetual <email>
node admin.js revoke <email>
# disable 同时禁用该账号的后续登录
node admin.js disable <email>
```

管理 Key 由命令在主机本地读取，不放在参数、截图或聊天中。注册发码限每 IP 每分钟 10 次（`AUTH_RATE_MAX`）、同邮箱 15 分钟 5 次；另有本机邮箱验证码日预算熔断 `EMAIL_DAILY_MAX`（默认 100/上海自然日，尽力而为）。非 AI HTTP 每 IP 每分钟 120 次。只有 loopback 的可信 nginx 可以设置真实客户端 IP；直连外网不得启用 TRUST_PROXY。

AI 路由已取消输出 token/字数上限、推理/温度覆盖、专用请求/响应大小限制、业务硬超时、并发/频率/日额度及 requestId 去重。每次请求独立调用上游，使用供应商生成默认值；不再重复验证业务 schema、过滤模型名或根据 finish_reason 拒绝已经能解析的 JSON。只识别三个固定 operation，不接受调用者替换系统提示词或官方模型配置。账号会话和权益在调用前后核验，业务结果由本地设置消费者负责使用，不透传原始 Provider response。

AI 的 nginx 路由不限制请求体大小，使用 300 秒常规代理读超时；本地客户端仍有自己的网络超时（当前试用 DMG 为 45 秒），本次服务器简化不修改已安装客户端。登录、订单和管理接口仍有基础 JSON 大小限制及认证校验。

不记录输入/输出正文、明文会话、密码、邮箱验证码或模型 Key。账号保存邮箱与 scrypt 密码哈希。AI 用量仅作审计，每次实际请求使用服务端生成的标识并保留 30 天，不参与准入；已撤销会话 30 天后删除。账号、订单、License 长期保留。`official_ai_failed` 仅记录 operation、失败阶段、上游 HTTP 状态和耗时。nginx 不得记录 Authorization 或请求体。

验证：`npm test`；Docker：`docker build -f Dockerfile.test -t metawork-official-test . && docker run --rm metawork-official-test`。测试使用独立临时数据库及本地上游桩，不调用真实付费模型。

详细部署和迁移见 [运行指南](../docs/current/official-account-operations.md)。
