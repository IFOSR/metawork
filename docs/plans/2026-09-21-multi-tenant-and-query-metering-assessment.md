# MetaWork 多租户服务与 Query 用量计费评估

- 评估日期：2026-09-21，Asia/Shanghai。
- 状态：现状评估已完成；升级建议待评审，未实施、未形成新的 Accepted ADR。
- 范围：当前工作区代码、相关 Accepted ADR、定向测试及两个无外部模型调用的最小复现。
- 边界：不是已安装 Server 的线上验收，不代表容量压测、安全认证或供应商账单核对已完成。
- 本轮交付：本评估文档和文档索引；未修改运行代码、部署配置或服务进程；未创建提交。

> 最终范围决定（2026-09-21）：本期只做单用户多任务必要修复、按 Query 的用量/阶段成本/MetaCoin 应计账单，以及第三方消费对接，具体以 [MetaCoin 详细实施方案 v2 定稿](2026-09-21-metacoin-query-billing-implementation-plan.md) 为准。钱包、余额、订阅收款、充值、支付、实际扣款与退款归外部独立系统；Provider 限制、强制统一模型出口、本地预算/余额控制和多租户升级均不在本期。Query 不等同 Task，可以没有 Task 但已经发生成本；不为计费提前创建 Task。订阅全额按 1:1 转为 MetaCoin 保留为外部商业规则。本文下文保留原始现状证据和较宽的早期建议，不作为本期实施清单；取消后继启动与清理前释放槽等补充问题已纳入定稿方案。

## 1. 结论

当前系统是**具备 AccountRuntime、统一 Gateway、多 Conversation 执行基础的单安装账户产品**，不是已经支持注册、用户授权、租户隔离和按 Query 结算的多租户 SaaS。

| 问题 | 当前结论 |
| --- | --- |
| 多个浏览器能否访问一个服务？ | 经网络入口配置后可以，但浏览器登录会话不等于独立业务用户 |
| 用户能否注册自己的账户？ | 当前 Web 是一套服务端预设账密，没有完整的多用户注册和成员体系 |
| 是否支持任务并发？ | 支持同一 Account 内不同 Conversation 的并发基础，不再是整个账户只允许一个 Task |
| 是否支持排队？ | 有输入 FIFO 和持久 Task 队列，但生产队列唤醒、边界控制存在已复现缺口 |
| 不同会话上下文是否分开？ | Planner transcript 等有独立会话边界；这不等于不同登录用户之间有隐私授权边界 |
| 不同租户能否安全运行任意任务？ | 当前默认 native 执行不满足互不信任租户的隔离要求 |
| 是否支持用户级资源公平性？ | 未形成用户/租户/宿主机/Provider 的完整分层准入与配额 |
| 是否能统计每个用户每个 Query 的 token？ | 底层部分可获取 usage；主系统没有完整归因、持久账本及查询投影 |
| 是否能准确按成本扣费？ | 当前不能；需要计量覆盖、价格版本、幂等结算、预算和对账 |

推荐路径：先补齐现有调度可靠性与用量采集，再接入真实身份和隔离的 Account 运行环境；收费前完成可信模型出口与账本闭环。保留 Web、Feishu、TUI 通过同一 Gateway 消费 Server 的架构，不建立第二个任务语义路由器或调度决策中心。

## 2. 现状：多人实际使用时会发生什么

### 2.1 登录用户目前会收敛到同一个业务身份

代码证据：

- [login-credentials.ts](../../src/management/login-credentials.ts)：明确为单账号预设账密，未配置时默认 `admin` / `123456`。
- [web-auth.ts](../../src/management/web-auth.ts)：登录会话保存 `clientId`，没有持久的 `userId`、Account membership 或角色。
- [server-composition.ts](../../src/server/server-composition.ts)：Web principal 固定为 `local-web-user`，Account resolver 总是授权 `local-default`。
- [web-gateway-session-runtime.ts](../../src/management/web-gateway-session-runtime.ts)：Workspace 操作使用固定 `web:local-web-user`。
- [web-gateway-adapter.ts](../../src/management/web-gateway-adapter.ts)：向 Gateway 提交 Web 命令时没有传递真实用户认证主体。

因此，两个人分别在两台电脑登录，不意味着创建了两个独立用户。即使在外部反向代理上增加不同用户名，如果没有把可信身份接入 MetaWork 的 Gateway 和 Account resolver，内部仍然是共享账户。

Feishu 虽然有 `tenantKey:userId` principal，当前生产 Account resolver 仍将其映射到同一安装账户。不能把飞书企业标识直接视为已经完成的 MetaWork 租户隔离。TUI 的本地安装身份也不是远程个人用户凭据。

### 2.2 输入排队和执行排队是两回事

| 层次 | 当前行为 | 重要限制 |
| --- | --- | --- |
| Conversation 输入 | `ConversationInputMailbox` 内存 FIFO，一次一个活跃输入；默认总占位 16，包含正在处理的输入 | 不等于持久 Task 队列；不能据此承诺进程崩溃后所有已收输入会自动续跑 |
| 同一 Conversation 的 Task | 一个持久执行槽，后续 Task 排队；清理和不确定残留影响释放 | 不能让新任务与旧任务未完成的清理重叠 |
| 不同 Conversation 的 Task | 默认账户上限 `maxConcurrentTasks=2` | 配置值不是租户级或整台服务器级上限 |
| Executor Attempt | 默认账户上限 4，单 Task 上限 2 | 一个 Task 可能有多次模型调用，Attempt 数不等于模型请求数 |
| Planner | 同一 session 串行写入，不同 session 的运行可以并发 | 未见与 Task 上限等价的全局 Planner 进程/模型调用限额 |

依据：[输入邮箱](../../src/session/conversation-input-mailbox.ts)、[配置 schema](../../src/configuration/schema.ts)、[AttemptSupervisor](../../src/execution/attempt-supervisor.ts)、[Planner supervisor](../../src/planning/planner-process-supervisor.ts)、[ADR-0037](../adr/0037-multi-conversation-task-parallelism.md)。

例如 A、B、C 在三个 Conversation 提问，可能同时进入 Planner；需要新建 Task 时，A、B 占满默认两个槽，C 的 Task 排队。A 内部可以有两个 Attempt，B 内部也可以有两个，但这不是“每个用户各有四个”。

“咨询”也不能一律按一次 Planner 请求理解：当前工作流中的研究、报告类问答可以通过 Work Graph 交给 Executor 完成，成本可能包含 Planner 和 Executor；纯查询命令则可能不调用模型。

### 2.3 已复现的调度缺口

**问题一：跨 Conversation 容量释放未形成完整唤醒闭环。**

[AccountStartupRecoveryService.onTaskTerminal](../../src/account/account-startup-recovery-service.ts) 只释放并提升结束任务所属 Conversation 的队列。若该 Conversation 没有后继任务，直接返回，并不扫描其他因账户容量不足而等待的 Conversation。

全账户 `listQueuedConversations()` 扫描在 `recover()` 启动恢复路径中；`recoverPeriodic()` 处理 blocked Task 和 `wait_for_capacity`，未覆盖这一持久排队场景。

使用真实内存 SQLite、migration、SchedulerRepo 和生产终止/周期恢复方法，注入无残留的依赖：

```text
初始：A occupied，B occupied，C queued(account_task_capacity)，上限 2
调用：onTaskTerminal(A)，然后 recoverPeriodic()
结果：A free，B occupied，C free，但 C 的 Task 仍为 queued
```

复现证明这条正常结束路径释放容量后不推进 C；不能据此承诺“用户等待前面任务结束就一定自动开始”。这是服务方法级复现，不是浏览器端到端负载实验。

**问题二：容量已满但目标 Conversation 无 active Task 时，队列上限可被绕过。**

[ControlKernel](../../src/kernel/control-kernel.ts) 的队列限制判断嵌套在 `proposal.task.taskId !== activeTaskId` 中。该场景两个值都是 `null`，因此跳过队列长度判断。

从现有 Kernel 测试 fixture 构造事件，直接调用生产 `ControlKernel.decide`：

```text
activeTaskCount = 2
目标 Conversation 没有 activeTaskId
queuedTaskCountByConversation[目标] = 8
sameConversationQueueLimit = 8（默认值）
实际决策：authorize_task_plan，scheduleState = queued
预期决策：拒绝第 9 个排队 Task，不产生半成品 Task
```

**问题三：调度策略函数存在，不代表生产路径已使用。**

[task-scheduler.ts](../../src/kernel/task-scheduler.ts) 有优先级、aging、fair-share 选择逻辑，但本轮 `rg 'selectTaskDispatches' src` 仅找到定义，未找到生产调用。当前同会话提升使用 FIFO，启动时跨会话扫描按 `conversation_id` 排序。因此不能把纯函数测试通过解释为生产已实现公平调度、aging 和防饥饿。

这些问题应优先在现有账户模式下修复；不要把升级方案简化成调大 `maxConcurrentTasks`。

## 3. 隔离能力与 B/S 服务风险

### 3.1 上下文隔离、访问权限、操作系统隔离是三个不同层次

**模型上下文层：**独立 Conversation 有独立 Planner session/transcript，同一 session 有串行运行保护；Task owner、证据、权限请求和资源引用也有作用域约束。两个人进入同一个 Conversation 时，共享会话历史是该模型的正常语义，不能期待系统自动按操作者分隔上下文。

**访问权限层：**当前所有 Web 用户是同一 principal。Workspace directory 有授权 seam，但生产注入的判断仅检查 principal 是否属于受认可的身份类型，而不是按用户校验 Workspace ACL 或允许访问的目录。其他浏览器会话不能被视为隐私边界。

**共享记忆层：**[Planner MCP](../../src/planning/planner-mcp-server.ts) 的 `getPlanningContext()` 读取当前 DB 中 `scope='global'` 的 confirmed preferences，没有用户维度过滤。当前共用 Account DB 时，这类偏好可以共同影响不同 Conversation。后续必须明确个人偏好与组织共享偏好，不能把现有 global 自动解释为个人。

**执行文件层：**不同 Task 的 worktree 有助于避免直接覆盖，同 Workspace 的最终 publication 仍可能串行等待或进入冲突修复。worktree 是工作组织手段，不是安全沙箱。

**系统资源层：**CPU、内存、磁盘、Provider 并发/RPM/TPM、网络连接和日志空间仍可能竞争；仅有逻辑上下文分隔无法防止一个用户拖慢整个服务。

### 3.2 当前 native Executor 不适合互不信任的租户

[运行安全文档](../current/phase-5-runtime-security.md) 明确 native worktree 不把进程限制在 Workspace 内，普通用户空间的其他路径仍可读写。[Codex driver](../../src/executor/codex-cli-driver.ts) 在非 response-only 的 native Attempt 使用 `danger-full-access`。

这意味着如果不加外部隔离，把多个租户的运行目录放到同一个服务操作系统用户下，目录命名和 `accountId` 无法阻止工具访问其他租户数据或服务配置。模型提示词和 capability 审计也不能替代实际文件、网络和进程权限。

已有 Docker compatibility backend 的限制可作为基础，但不是现成的 SaaS 安全认证。仍需验证 mounts、宿主身份、网络出口、资源限制、镜像供应链、凭据和特殊 sandbox 配置。只把整个 MetaWork 服务塞进一个共享容器，并没有隔离容器内的租户。

### 3.3 不能仅通过监听公网地址完成服务化

[management/server.ts](../../src/management/server.ts) 当前监听 loopback，Origin 规则面向 localhost/127.0.0.1；Web session 为内存状态，cookie 没有 `Secure`，服务端未形成显式会话过期和跨副本状态管理。

上线至少需要：TLS、受信反向代理配置、明确 Origin/CSRF 策略、持久身份与会话撤销、非默认账密、角色化管理权限、上传与目录边界、分层限流和审计。不能靠放开 CORS、信任任意转发身份 header 或把管理面全暴露给已登录用户解决。

远程 Web 的 Workspace 路径属于服务器，不是浏览器用户电脑。建议只允许选择已授权的服务端 Workspace，或通过受控 Git 导入/上传创建，不开放服务主机任意绝对路径浏览。

## 4. Token 与成本现状

| 链路 | 已有数据 | 缺口 |
| --- | --- | --- |
| Pi session | assistant usage；`getSessionStats()` 汇总 input/output/cacheRead/cacheWrite/cost | session 累计不是业务 Query 账本，不能自动归因用户和后台调用 |
| MetaWork Planner | run ID、模型 binding/config revision、耗时、重试次数、工具调用摘要 | supervisor 与 PlannerRunRepo 没有统一 usage 落库和 Query 归因 |
| Codex Executor | driver 消费 JSONL 事件，包括 `turn.completed` | 当前处理没有把 usage 转成规范计量事件 |
| Pi Executor | 解析 message/turn/agent 结束事件和输出 | 未统一记录每次模型请求 usage |
| 图片模型 | 获取响应并提取图片 bytes/mime | 没有完整保存计量单位、用量和供应商请求标识 |
| Attempt model gateway | Attempt bearer token、保管上游凭据和转发 | 未承担统一计量；也不是所有 Planner/native Executor 请求的必经出口 |

主要依据：[Pi session stats](../../planner/AnyFusion-Pi/packages/coding-agent/src/core/agent-session.ts)、[PlannerRunRepo](../../src/storage/planner-run-repo.ts)、[Planner supervisor](../../src/planning/planner-process-supervisor.ts)、[Harness driver](../../src/executor/harness-driver.ts)、[Codex driver](../../src/executor/codex-cli-driver.ts)、[Pi driver](../../src/executor/pi-cli-driver.ts)、[image API](../../src/executor/image-api-client.ts)、[Attempt model gateway](../../src/execution/attempt-model-gateway.ts)。

现有 `AttemptModelGatewayServer` 先 `arrayBuffer()` 聚合上游响应再返回，并不是可直接承担全模型流量的实时 SSE 计量代理；本轮找到的生产实例化在 image container adapter，不能认为所有模型调用已经经过它。

结论：部分历史 Pi session 可能恢复出部分 usage，但不能保证还原“某个人这次问题的全部成本”。历史缺失数据应标记 unknown/部分覆盖，不应使用最终回答长度或会话累计差值补造精确账单。

此外，成本至少分三种：供应商计量的模型用量、依据价格表计算的成本、供应商实际结算金额。订阅制 CLI、本地模型、企业折扣和用户自带 Key 应分别定义，不得一律假设 token 乘公开单价就是实际现金支出。

## 5. 升级路径选择

| 方案 | 适用范围 | 取舍 |
| --- | --- | --- |
| 共享团队工作台 | 完全信任、允许共享数据与配置的小团队 | 改动最少，但不能声称个人隐私隔离或商业多租户 |
| 统一入口 + 隔离 Account Worker | 局域网多人使用、初期商业托管 | 推荐；每租户独立运行根/DB/凭据和执行安全边界，复用现有 AccountRuntime |
| 共享分布式执行集群 | 大量租户、弹性扩缩容 | 需要跨节点租约、fencing、全局资源事实和运营系统，不宜作为第一步 |

初期建议注册用户拥有一个个人 Account；如果明确需要组织协作，则 Account 表示组织、User 通过 membership 加入。两者都复用 Account 作为数据和计费隔离边界，不能把 User、Account、Conversation 当作同一对象。

推荐目标拓扑：

```text
Web / Feishu / TUI
  -> authenticated transport
  -> Gateway: identity, membership, object authorization, idempotent admission
  -> Account routing / worker ownership
  -> isolated AccountRuntime
       -> Conversation mailbox / Planner
       -> Kernel decision + durable workflow
       -> Runtime / isolated Attempts / publication
       -> Usage outbox
  -> Gateway projections: progress, results, queue, usage

Trusted model egress
  -> scoped call credential + provider adapter
  -> normalized usage -> durable usage ledger -> rollups / reconciliation
```

外层负责身份和物理资源额度，不解释自然语言、不选择 Subtask、不自行发起 retry。Account Kernel 仍是任务策略的唯一 owner；新增宿主机资源租约作为容量事实参与决策，不另建一套会抢任务的调度器。

## 6. 多租户具体改造

### 6.1 身份与授权

建议新增 `users`、`external_identities`、`accounts`、`account_memberships`、可撤销登录 sessions，以及 Workspace/Conversation 的授权关系。具体表名属于后续设计，不是已发布契约。

- Web 从服务端验证后的 session 生成 principal；TUI 使用可撤销、带作用域的用户 token。
- Feishu 从经验证的企业/用户标识绑定统一 User；不能凭客户端声明的 `userId` 认人。
- Gateway 从 principal 与 membership 解析 accountId；客户端可以请求切换账户，但不能自行授权目标账户。
- Workspace 成员权限与 Conversation 的私有/共享权限显式建模。组织成员身份不能自动授予所有个人 Conversation 内容。
- Task 查询/取消、events/replay、附件下载、ResultReference、计量查询、搜索、目录浏览、配置、MCP 都按同一对象权限规则检查，禁止只在列表页面过滤。
- 区分 platform admin、account admin、member；普通用户不得修改全平台 Provider 密钥、模型出口和权限 profile。
- 每个计费请求保存提交时身份；审计同时保存 actor 与 billable owner，不通过 mutable current session 推断。

### 6.2 AccountRuntime 真正独立装配

[Account paths](../../src/account/account-paths.ts) 和 [Runtime registry](../../src/account/runtime-registry.ts) 提供了基础，但 [production composition](../../src/server/server-composition.ts) 大量绑定 `local-default`；[Account runtime composition](../../src/account/account-runtime-composition.ts) 的 factory 回调闭包复用已构造的 services。

不能仅将 resolver 改成返回多个 accountId。需要将 DB、configuration、secret store、repositories、Planner homes/sessions、workspaces、results、journals 和 recovery 都从受信 `AccountContext` 装配；registry 每个 Account 对应独立 bundle，并有可验证的初始化、空闲回收与关闭行为。

第一阶段可以保留每 Account 独立 SQLite，不要求为“小规模多人”立即重写成 PostgreSQL。每份 Account DB 和运行根只允许一个活跃 worker owner；多副本不能共用同一可写目录或各自启动 Kernel。跨节点迁移前需 durable lease/fencing、可恢复 inbox/outbox 和备份恢复方案。

### 6.3 执行与数据安全

优先选择每租户独立 worker 的 OS 身份或隔离容器/VM，并给实际执行不可信工具的 Attempt 设置资源和网络边界。仅为两个目录赋不同名称不算隔离。

- 不挂载其他租户目录、服务控制凭据、个人 home、宿主 Docker socket；Provider 凭据由可信出口代持。
- 每租户独立 secrets、上传区、运行目录、结果区、缓存命名空间；共享缓存必须经内容和权限审计。
- 阻断跨租户文件/进程探测、内网管理地址和云 metadata 访问；为必要外部访问配置 allowlist。
- CPU、内存、进程数、磁盘与日志、网络、模型请求均有可观测额度；失败不能拖垮控制面。
- Git publication 遵守 Workspace ACL、锁与冲突修复；共同写同一仓库必须是显式协作，而非默认跨租户共享。
- account global memory 仅向授权范围共享；新增 user-private scope，并明确迁移旧 global preference 的归属。

### 6.4 调度闭环与公平性

先为第 2.3 节写生产 seam 回归测试，再将 account-wide scheduling event 接入现有 Kernel/Workflow，真正消费全 Conversation snapshot 与 `selectTaskDispatches`。

触发条件至少覆盖新 Task、Task 结束、Attempt 结束、取消清理完成、资源释放、配额变化、启动恢复和定时对账。Runtime 只事务性应用 Kernel 授权的 reservation；claim 竞争失败回报事实、重新决策，禁止直接启动未经授权的工作。

队列上限应同时覆盖有 active Task、没有 active Task 但账户容量已满、零队列配置、恢复重新入队和并发入队。每用户、每账户还需 pending 总量限制，避免通过大量新建 Conversation 绕过单会话上限。

保留同会话 FIFO；账户内 priority/aging/fair-share、用户配额和资源事实统一进入 Kernel。新增 Planner 并发/RPM/TPM 限额，不用 Task cap 代替模型入口限流。

跨账户共享宿主机/Provider 的容量由原子资源额度服务发放有期限租约，Kernel 根据额度事实决定排队或执行。强制回收、抢占等新政策必须单独定义，不隐藏在 Executor adapter 中。

UI 通过 Gateway 展示 `input_queued`、`task_queued`、`running`、`cleaning_up`、`blocked` 等事实及结构化等待原因；动态优先级调度下不承诺固定排队名次或精确开始时间。

### 6.5 现有安装迁移与兼容

保留现有 `local-default` 数据的完整归属，由安装管理员认领为一个旧账户；不能根据过去的浏览器 clientId 推断真实用户，并自动拆分历史对话。现有飞书身份绑定经管理员确认迁移，新用户默认获得新的 Account 或显式 membership。

身份、Gateway 和持久表变更按版本整体切换：先备份并验证恢复，停止接收新执行请求，处理运行中任务与恢复残留，再迁移。旧 token 撤销或重新认证；不能让新旧身份解释同时作用于同一账户。

计量迁移给历史记录标记 `legacy`、可恢复覆盖率和未知费用。新请求从一个明确的启用点开始具备完整 Query 归因，不倒填虚构的用户、调用 ID 或零成本。

Web、Feishu、TUI 共用新的身份/授权与查询 port；可复用单机模式，但单机身份映射必须显式限定在本地部署，不能成为远程认证失败时的兜底。协议升级需验证三端连接、恢复和事件重放，不能承诺身份重构对现有端完全零影响。

## 7. Query 计量与成本方案

### 7.1 计量根不能是 Task ID

定义 Query 为一次被服务端接受、具有稳定幂等身份的用户语义请求。为其分配 `queryId`，与已有 request/turn 对应，不要求新建一个竞争性的业务生命周期。

```text
User + Account
  -> Query (request / turn / origin)
  -> Planner runs
  -> zero or more Task execution segments
  -> Subtasks / Attempts
  -> individual model calls and non-token billable operations
```

没有 taskId 的澄清、拒绝前规划、no_op 也可能已经消耗 token。一个 Query 可以包含很多模型调用，一个 Task 可以由后续 Query 继续执行。只给 Task 加 `token_total` 无法满足问题。

建议归因规则：

- 自动 retry、fallback、replan、后台继续执行，归属触发该执行段的 Query 与付款 Account。
- 用户明确 Resume/追加请求产生新 Query；之后的新执行段归新 Query，既有支出不重写。
- 用户点击停止不将此前运行成本转移给点击者；停止审计 actor 和原执行计费 owner 分开。
- 系统健康探测、平台维护、无法归因的旧任务放入显式 system/legacy bucket。
- Feishu/Web/TUI 的重复投递与事件 replay 不产生新计费 Query；不同渠道的“同一句话”也不能仅凭文本去重。

### 7.2 持久数据模型

以下是建议模型，字段可沿用既有 ID，但必须有确定的语义 owner：

| 记录 | 关键字段与职责 |
| --- | --- |
| `query_records` | accountId、actorUserId/principalId、queryId、requestId、turnId、conversationId、source、admittedAt、幂等键 |
| `execution_charge_contexts` | executionSegmentId、originQueryId、billableAccountId、actor、taskId、generationId、恢复所需不可变上下文 |
| `model_calls` | modelCallId、parentCallId、queryId、plannerRunId/attemptId、providerRef、modelId、configRevision、stage、startedAt、endedAt、providerRequestId |
| `usage_events` | 追加式 observation、call ID、来源事件 ID、原始 usage、规范计量单位、累计/增量语义、可信程度、发生/接收时间 |
| `price_versions` / `cost_entries` | 生效版本、Provider/model/tier、币种、单位价格、计算成本、调整引用、对账状态 |
| `budget_reservations` / outbox | 预留、结算、释放、待核对余额、幂等传播；与调用及恢复状态关联 |

Planner-only 调用允许 taskId/attemptId 为空；不能为了数据库 NOT NULL 约束伪造 Task。身份和计费上下文必须在入队、派发、重试、重启恢复之间持久传递。

建立独立的 Usage/Metering 应用 port；Adapter 提取 usage、Runtime 传递不可变归因、Storage 实现持久化、Gateway 提供授权查询投影。Kernel 只消费预算/容量事实，不解析供应商 JSON、不计算价格、不直接写账表。

### 7.3 采集位置及覆盖范围

第一步在当前受信执行链采集真实结构化 usage：

- Planner supervisor 接 Pi assistant 完成事件；为自动 compaction、summary、retry 等额外请求设置独立采集 seam，不能只累计最终正文。
- Codex/Pi driver 输出规范化 UsageObservation；先针对实际安装 harness 的事件 schema 建 contract fixture，不能假定所有版本都有相同字段。
- Image API adapter 保留请求标识、图片计量单位与供应商 usage；其他付费工具分别计量。
- 每次外部请求分配新的 modelCallId。多个工具轮次、修复轮次、重试是不同实际调用；重复处理同一结束事件不是新调用。

第二步建设可信、可流式转发的模型出口，覆盖 Planner、Executor、压缩、重试和图片等全部需要计量的路径。复用现有 Attempt proxy 的隔离思想，而不是原样扩散其响应聚合实现。

出口需要：带不可变归因的短期作用域 token、固定上游/路径/模型 allowlist、由服务端指定项目/组织与凭据、并发预算预留、有界 SSE 转发和解析、取消/断流处理、durable usage outbox。不得接受客户端提供的账单 Account 或最终 cost。

若租户可以绕过出口直接用宿主 Provider Key 调用模型，就不能宣称执行了不可绕过的硬预算。用户自带 Key 的不可控流量应标成 coverage 不完整，或者在产品能力上明确不支持。

### 7.4 规范化与成本公式

保留原始供应商 usage，并按 adapter 语义规范化为互不重叠的计价项。输入、缓存读取、缓存写入、输出、推理 token 的包含关系必须明确；例如已包含在某个总数里的子项不能再全额叠加计费。

```text
call_calculated_cost =
  SUM(disjoint_billable_quantity[i] * versioned_unit_price[i])

query_calculated_cost =
  SUM(attributed_call_cost) + SUM(attributed_non_token_cost) + adjustments
```

价格按供应商、实际模型、service tier、调用时生效版本和币种保存快照；使用整数最小计价单位或 decimal，不用浮点累加金额。没有配置价格时显示“价格未知”，不能当免费。

分别展示：token/其他用量、计算成本、已对账供应商成本、对客户的销售收费。折扣、汇率、退款、本地 GPU 成本分摊、订阅制 CLI 分摊都单独记录政策，不能悄悄改写历史基础 usage。

精度状态至少有 `reported`、`estimated`、`unavailable`，并与 `pending`、`final`、`reconciled` 等结算状态分开。没有完整供应商反馈时不能保证逐 Query 与最终发票完全相等。

### 7.5 幂等、故障和预算

- 调用前记录 call start 与 reservation；可信 worker 以 durable outbox 重试投递 usage。按稳定 event ID 去重，再生成可重建聚合。
- 同一调用的累计 usage 快照按序替换或求增量，不逐条累加；不同真实 retry 调用必须分别记录。
- Cancelled/failed 调用可能已经消耗资源，不能因任务未成功而归零；客户退款用调整分录表达。
- 上游已完成但本地崩溃丢失末尾 usage 时，保留 pending/unknown，尽可能用 providerRequestId 对账；不能凭成功状态假造 token。
- 用户、Account、Provider、host 的预算/额度预留必须原子化，避免同时启动多个调用各自看到同一余额。
- 先实现软预算告警；硬预算需限制最大生成量、单次调用上界、并发预留和绕过出口能力。无法约束上游最大费用时不能承诺零超额。
- Ledger 不可用时，收费部署拒绝新的付费调用或使用有界可靠 spool；运行中的调用继续记录待对账事实。只读状态查询和取消不应被预算不足阻塞。

### 7.6 查询与客户端呈现

提供服务端只读应用 API：Query 明细、用户日/月汇总、Account 汇总、模型/stage 分布、账单导出和 coverage。个人只能读取自己授权范围，Account admin 的组织账单权限单独授权。

Web 展示问题下方总量与 Planner/Executor 展开明细；TUI 和 Feishu 读取同一投影，而不是各自解析模型日志。实时计量更新只更新 cost projection，不改变 Turn/Task 是否已经 cancelled/completed，防止终态 UI 被迟到 usage 重新打开。

Task 结束不等于费用已全部对账。前端允许“任务完成，费用待核对”，并显示 `asOf`、coverage 和缺失调用数；不给无法保证的“最终精确费用”标签。

## 8. 分阶段交付与验收

| 阶段 | 主要改动 | 必须通过的门槛 |
| --- | --- | --- |
| P0：可靠性与观测 | 修复跨会话唤醒和队列限额；接入 Kernel 全账户调度；Query 归因与基础 usage ledger | A/B 满载后 C 无需重启即可执行；有界队列；重复事件不重复统计；缺失 usage 显式可见 |
| P1：可隔离的多人服务 | 真实身份/membership、Gateway 授权、独立 Account bundle、隔离 worker/attempt、TLS/会话和目录限制 | 两个账户全链路越权测试、进程文件/网络隔离测试、跨端相同身份绑定与数据迁移 |
| P2：可运营计量与收费 | 完整模型出口、所有付费调用覆盖、价格版本、预算、对账、授权报表 | 取消/重试/崩溃不漏记或重复计费；预算竞争原子化；账单可追溯和可解释 |
| P3：按容量需要扩展 | Account worker 分片、租约 fencing、宿主/Provider 额度、运营与恢复 | 单 Account 单 owner、故障迁移不双跑、持续压测与备份恢复验收 |

P0 的单账户 token 报表只是过渡观测，不能命名为“真实多用户账单”。P1 上线前不能把同一服务对不互信租户开放；P2 通过前不应按未核实的数字自动扣款。阶段可并行开发，但上线门槛不能互相替代。

主要实施位置：

| 工作包 | 现有模块入口 |
| --- | --- |
| 登录与身份传递 | `src/management/login-credentials.ts`、`web-auth.ts`、`web-gateway-adapter.ts`，`src/gateway/account-resolver.ts`，`src/server/server-composition.ts` |
| Account 数据/生命周期 | `src/account/account-runtime-composition.ts`、`account-runtime-factory.ts`、`runtime-registry.ts`、`account-paths.ts` |
| 队列与恢复 | `src/kernel/control-kernel.ts`、`task-scheduler.ts`，`src/account/account-startup-recovery-service.ts`，`src/storage/conversation-task-scheduler-repo.ts` |
| 计量 Adapter | `src/planning/planner-process-supervisor.ts`，`src/executor/harness-driver.ts`、Codex/Pi/image adapters，vendored Pi 隐藏调用 seam |
| 持久账本 | 建议新增独立 `src/metering/` domain/application ports；SQLite adapters/migrations 在 `src/storage/` |
| 模型出口 | `src/execution/attempt-model-gateway.ts` 的安全思想与 provider adapter，明确拆分流式计量 owner |
| 客户端报表 | 既有 Gateway 查询/事件契约和 Web、Feishu、完整 Pi TUI 展示 adapter |

实施前需新增/修订租户安全、计量归因、收费政策和资源准入相关 ADR，并同步 `CONTEXT.md`、当前技术总览和必要 onboarding。当前文档只提出建议，不能替代 ADR-0020/0031/0037。

### 8.1 最低测试矩阵

| 场景 | 断言 |
| --- | --- |
| 两用户两个 Account | HTTP、Gateway、事件订阅/replay、下载、结果引用、MCP、费用 API 均拒绝跨账户访问 |
| 同 Account 私有 Conversation | 无对应 ACL 的成员不能读正文、附件、证据或取消任务 |
| A/B/C 争抢两个槽 | 任一槽释放后唤醒其他 Conversation；残留未清理不得提前复用 |
| 已满队列/大量空会话 | 队列上限在所有分支生效；用户/账户 pending 总量有限 |
| 优先级和 aging | 验证生产 Kernel 路径，不仅测试 scheduler helper；长期等待不被无限插队 |
| 恶意工具任务 | 不可读其他租户和控制面 secrets；不可绕过出口或访问管理网络；超额只影响自身 |
| 跨端重放 | 同一 admitted query 不重复调用/扣费，其他用户不能凭幂等键取走 receipt |
| Clarification/no_op | taskId 为空仍记录实际 Planner usage；无模型调用的查询不伪造用量 |
| 自动 retry/手动 resume | 实际调用逐个计量；执行段归因稳定，不按 mutable current user 归账 |
| 取消/断流/进程崩溃 | 已知 usage 保留，缺失 usage 标未知；余额预留可恢复且不重复释放 |
| 缓存/推理/图片/多币种 | 不重复计算包含项；计价单位、价格版本和币种可追溯 |
| Account worker 故障 | recovery 不能串账户；fencing 防止同账户双活执行和重复 publication |

### 8.2 本轮验证记录

本轮执行 13 个现有定向测试文件，148 个测试全部通过：

```text
tests/kernel/task-scheduler.test.ts
tests/kernel/control-kernel.test.ts
tests/storage/conversation-task-scheduler-repo.test.ts
tests/account/account-startup-recovery-service.test.ts
tests/security/gateway-account-isolation.test.ts
tests/security/workspace-directory-account-isolation.test.ts
tests/account/runtime-registry.test.ts
tests/account/account-recovery-isolation.test.ts
tests/session/conversation-input-mailbox.test.ts
tests/execution/attempt-supervisor.test.ts
tests/planning/planner-process-supervisor.test.ts
tests/management/web-auth.test.ts
tests/management/login-credentials.test.ts
```

另通过两个不写仓库文件、不访问线上 DB 的 Node 探针，复现第 2.3 节的缺失唤醒和队列限额绕过。现有测试通过与这两个缺口并不矛盾：测试覆盖了若干局部能力，没有覆盖这些生产组合场景。

未执行多租户真实负载压测、攻击隔离验收、所有模型供应商真实 usage 对账或已安装服务的现场多端验收。本轮没有修复上述两个调度问题，它们应进入下一阶段明确的修复范围。

## 9. 待产品确认的选择

- 初期租户是“一用户一账户”，还是组织 Account 下多个成员；建议先个人 Account。
- 服务是否允许互不信任用户执行工具/代码；建议服务化按不互信处理，不把局域网当安全边界。
- 首版只提供 token/估算成本报表，还是直接向客户扣费；建议先观测与对账，再开启收费。
- Provider 凭据由平台提供还是用户自带；必须明确后者的出口控制与成本口径。
- 是否需要共同写同一 Workspace；建议默认私有，协作通过显式 ACL 开启。

以上未确认项不影响现状判断：当前不能把多浏览器、多 Conversation 并发和 Pi session usage 等同于已经可用的多租户计费产品。
