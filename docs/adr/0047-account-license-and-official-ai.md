# ADR-0047: 官方账号授权与内置 AI 服务边界

- Status: Accepted
- Date: 2026-10-09
- Design: [已确认产品方案](../plans/2026-10-09-account-license-and-managed-internal-ai-design.md)

## Decision

商业身份独立于本机 `AccountRuntime`。`src/authorization/` 应用服务拥有一个仅存于内存的官方会话、代次隔离及规范化权益投影；重启必须重新登录。Web/Desktop 经本机 Management 接口登录，原有本地 Cookie/Bearer/桌面票据认证继续生效，官方身份不授予本机访问权。TUI/飞书共享 Gateway 准入，拒绝时引导到 Web/Desktop。

每次新生产性请求在线核验（包括显式 resume/unblock/retry），同时核验单飞。活动工作期间，成功核验后 24 小时才执行下一次后台核验；失败消耗本次每日尝试，无快速重试。无活动工作不执行后台网络查询。官方时间与本机单调经过时间用于已知到期判断，时钟异常/睡眠恢复关闭准入直至核验。所有异步结果按会话代次隔离；退出先关闭本地准入再撤销远端会话。

Kernel 的 `ProductionAuthorizationFact` 仅含 allowed/reason。纯策略 `allowsKernelAction` 区分生产性动作和安全收尾：新计划、派发、恢复尝试、重试、重规划及能力授予关闭；取消、落盘、终态处理和清理保留。`ControlKernel` 对所有 snapshot 应用策略；`DurableKernelWorkflow` 对已签发的生产性 application 暂缓重放，同时继续处理允许的清理；`AttemptSupervisor` 在领取排队尝试前应用同一纯策略。应用层 Planner 队列、Replan Worker 消费同一事实，不发起额外网络核验。Runtime 不拥有另一套恢复政策。

既有尝试允许完成当前工作并回报事实，后续派生受 Kernel 阻断。登录前必须等待活跃 Planner/请求保留/资源租约/发布清理收尾；同一进程中更换账号时不得继承旧账号未结束任务，需由旧账号继续或取消。账号登录不提供云同步或本地多租户隔离。

生产 `InternalLlmService` 无条件使用官方业务接口；URL 缺省为官方 HTTPS 地址，覆盖也必须使用 HTTPS。三个固定 operation 为 `responsibility_rewrite`、`model_summary`、`capability_explanation`。本机发送必要业务资料，不发送系统提示词或内置上游配置。官方每次独立核验会话和权益，并在上游完成后再次检查撤销/到期。官方只解析模型返回的业务 JSON，不透传 Provider response；业务字段校验由本地设置消费者负责。显式研发依赖注入可以直连，但生产装配绝不加载旧 internal 文件或失败回退。

官方一期是独立 Node 22 服务与 SQLite 数据库；本机数据库 schema 不变。账号密码使用异步 scrypt，随机会话仅保存摘要。服务端定义价格，试用按账号一次，事务写入订单与试用权益；幂等键按账号隔离并核对套餐。月/年订单仅 `pending_payment`，无权益；支付渠道接入和交易结算后续实施，不能以管理员模拟付费或浏览器跳转授予权益。内部永久权益仅通过 SSH 后的 loopback 管理入口签发，公网反向代理拒绝管理路径。

2026-10-10 用户确认简化内置 AI：取消 AI 专用请求/响应大小与字数上限、服务端输入/输出 schema、模型名/内容过滤、结束原因拒绝、输出 token/温度/推理参数、单次业务超时、并发/频率/日额度及 requestId 去重。使用供应商默认生成设置；AI 路由不受通用 HTTP 频率计数限制。保留固定 operation、JSON 解析、上游连接错误处理、登录/权益及管理入口保护；常规 HTTP 网络超时仍负责释放失联连接。登录、订单等非 AI 接口的校验与限流维持原义。不记录密码、会话明文、输入/输出正文或上游原始错误。每次实际调用单独记录必要 AI 审计元数据并保留 30 天，不用于限额；账号、订单、License 为权益核验事实。

## Affected decisions

本 ADR 扩展 ADR-0020 的应用服务依赖边界、ADR-0023 的恢复前提，修订 ADR-0031/0034/0039/0045 的官方会话与客户端投影。它替代 ADR-0044 中普通生产依赖本机 internal LLM 配置的规定，不改变设置确定性激活、AI 不授予权限的原则。ADR-0042 的 Query 用量与订阅计费继续分离。

## Consequences

- 干净安装无需 internal Key；已有 Provider/Planner/Executor 配置仍由用户管理。
- 正式启动不读取旧 internal 文件，不自动迁移或上传 Key；旧文件保留供维护人员按运行指南清理。
- 每日核验接受本地活动对提前撤销约 24 小时的发现延迟，官方 AI 不存在此延迟。
- 目前服务部署在 huoshan；真实内置 AI 验收依赖官方供应商配置。部署和测试证据见[运行指南](../current/official-account-operations.md)，不把单元测试等同于全部产品验收。
