# MetaWork 官方服务

账号、会话、套餐、待支付订单和固定内置 AI 业务接口共用 Node 22.19+ / SQLite。运行入口 `npm ci --omit=dev --ignore-scripts && npm start`，配置见 `.env.example`。`ADMIN_TOKEN` 必须是至少 32 字符的随机秘密，`.env` 权限 600；不要提交真实配置和数据库。

现部署于 `huoshan:/root/metawork-offical-server/`，systemd 单元 `metawork-official`，监听 loopback 8780。公网 HTTPS 入口 `https://14.103.216.193:9222/`，代理配置见 `deploy/nginx.conf`，管理路径在 nginx 被拒绝。

2026-10-10 按用户要求简化内置 AI：只配置模型地址、Key 和 Model ID，生成参数使用供应商默认值。`MODEL_THINKING` 和 `AI_DAILY_GLOBAL_LIMIT` 已删除；修改模型配置后重启 `metawork-official.service`，客户端无需重装。

公开接口：

- `POST /v1/auth/register`：邮箱作登录名、12–128 字符密码；不代表邮箱所有权验证。
- `POST /v1/auth/login`、`GET /v1/auth/session`、`POST /v1/auth/logout`。
- `GET /v1/entitlement`、`GET /v1/plans`、`POST /v1/orders`。
- `POST /v1/ai/operation`：固定 operation、requestId、input。提示词由 `prompts.js` 按 operation 选择，输入作为业务数据传入，模型返回的 JSON 交给本地设置消费者解释。

订单 `idempotencyKey` 长度 8–128，使用字母、数字、下划线或连字符。键按账号隔离，重复请求不得换套餐。试用七天，仅一次；月/年订单目前仅待支付，不能授予付费权益，也没有伪造支付成功的管理端点。真实结算后续接入时须核验交易、金额、币种、账号和订单，事务性去重，按 `addCalendarMonths` 从 `max(now, expiresAt)` 顺延同套餐；变更套餐另行定义。

内部永久权益操作（账号须先在 Web/Desktop 注册）：

```sh
ssh huoshan
cd /root/metawork-offical-server
node admin.js grant-perpetual user@example.com
node admin.js revoke user@example.com
# disable 同时禁用该账号的后续登录
node admin.js disable user@example.com
```

管理 Key 由命令在主机本地读取，不放在参数、截图或聊天中。账号注册/登录限每 IP 和每邮箱每分钟 10 次；非 AI HTTP 每 IP 每分钟 120 次。只有 loopback 的可信 nginx 可以设置真实客户端 IP；直连外网不得启用 TRUST_PROXY。

AI 路由已取消输出 token/字数上限、推理/温度覆盖、专用请求/响应大小限制、业务硬超时、并发/频率/日额度及 requestId 去重。每次请求独立调用上游，使用供应商生成默认值；不再重复验证业务 schema、过滤模型名或根据 finish_reason 拒绝已经能解析的 JSON。只识别三个固定 operation，不接受调用者替换系统提示词或官方模型配置。账号会话和权益在调用前后核验，业务结果由本地设置消费者负责使用，不透传原始 Provider response。

AI 的 nginx 路由不限制请求体大小，使用 300 秒常规代理读超时；本地客户端仍有自己的网络超时（当前试用 DMG 为 45 秒），本次服务器简化不修改已安装客户端。登录、订单和管理接口仍有基础 JSON 大小限制及认证校验。

不记录输入/输出正文、明文会话、密码或模型 Key。AI 用量仅作审计，每次实际请求使用服务端生成的标识并保留 30 天，不参与准入；已撤销会话 30 天后删除。账号、订单、License 长期保留。`official_ai_failed` 仅记录 operation、失败阶段、上游 HTTP 状态和耗时。nginx 不得记录 Authorization 或请求体。

验证：`npm test`；Docker：`docker build -f Dockerfile.test -t metawork-official-test . && docker run --rm metawork-official-test`。测试使用独立临时数据库及本地上游桩，不调用真实付费模型。

详细部署和迁移见 [运行指南](../docs/current/official-account-operations.md)。
