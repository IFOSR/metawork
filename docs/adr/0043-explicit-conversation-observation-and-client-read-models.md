# ADR-0043: Unified Multi-Client Control, Conversation Observation And Read Models

- **Status:** Accepted（2026-10-03，依据用户要求严格实施的授权）；已完成本地源码实施、全仓回归、生产浏览器及隔离安装验收；用户正常安装、Docker 与真实平台验收仍待完成。
- **Date:** 2026-10-02
- **Revision:** 本次修订确立完整多端查看与控制；原草稿中保留 origin 专属权限、将非来源端作为只读观察者的设计已撤回。
- **Scope:** Web、单一 TUI、Feishu 的同账户统一身份、会话实时观察、发送/停止/审批、并发操作、通知路由与有界读模型。
- **Supersedes:** ADR-0036。来源不再限制详细实时可见性或操作资格；其持久历史、安全投影、避免跨会话混写与定向通知目的由本 ADR 吸收。
- **Amends:** ADR-0031 的统一多端操作契约；ADR-0035 的浏览/操作目标与执行 attach 解耦；ADR-0040 增加可从任意端调用的确切后台 Task 取消入口，保持原 `cancel_turn` 语义；ADR-0041 的观察及统一操作能力清单。
- **Preserves:** ADR-0020、ADR-0032、ADR-0034、ADR-0037、ADR-0042 的领域权威、身份隔离、执行、交付和计费契约；ADR-0040 的精确目标、取消 fence 与旧 Turn 不误伤新 Turn。
- **Related design:** [前端观察架构升级详细方案](../plans/2026-10-02-frontend-observation-architecture-upgrade-design.md)。

## Context

Web 当前以单个活动会话适配器和单个 `liveTurn` 承载浏览、事件恢复和执行展示。切换时的历史 attach 路径会折叠全部保留事件，再补充执行轨迹、产物与账单。已有工作区改动通过缓存优先、浏览与激活并行改善等待，但不能从根本上限制冷读取的工作量，也不能完整表达多个后台任务的独立进度。

ADR-0037 已允许跨 Conversation 并行执行；ADR-0036 则将详细实时投递限制到 origin connection。`GatewaySubscriptions` 对详细事件检查 `liveConnectionId` 与 target，一些 UI 因此无法持续观察其他来源的任务。代码证据说明这是消息路由与展示限制，不证明所有命令后端都存在 origin ACL；现有 Gateway 已有共同的 Account 解析、命令准入和账户权限服务。

DeepSeek Harness 的同 Host 客户端经认证后代表同一个 operator；`session.follow` 按 Session 身份筛选，普通 `prompt/cancel` 也按 Session 调用，无“原发起连接独占任务”的条件。它把共享任务事实和各端本地视图分开。MetaWork 采用该原则，并保留自身账户映射、TaskView、Kernel 权限批准和结果认证。本文的持久审批仲裁、Feishu 通知路由及后台 Task 精确取消是 MetaWork 设计，不声称来自 DeepSeek 的相同实现。

## Decision

### 1. 同账户多端同权，任务归 Account/Conversation

连接到同一个 Server、映射到同一个 Account 的 Web、TUI 和 Feishu 使用相同的业务授权规则。任务来源、当前 focus、连接是否断开、是否曾发送第一条消息都不是授权条件。

三端均可发现会话、读取历史和结果、订阅进度、继续发送、停止明确目标以及处理待审批请求。当前产品不引入按端区分的 viewer/controller 角色或独占控制 lease。若将来增加主体角色，差异只来自明确的账户/资源授权，同一主体在各端一致，不根据 transport 推断。

连接 ID 管传输、principal 标识已认证操作者、Account 定义数据范围、origin 记录来源、notification route 定义通知目的地。它们不得互相替代。Feishu callback 必须从验证后的发送者解析 Account，chat/thread 本身不授予账户权限。

### 2. 分离目录、观察、命令和通知

Gateway 增加带版本和 capability 的只读观察接口。它接受已经认证的连接及明确的 Workspace/Conversation 目标，授权成功后返回轻量历史基线、当前任务集合、安全输出基线与后续读投影变化。

观察资源不创建 Planner 会话、不授权执行、不占用 Conversation 执行槽，也不以观察数量改变任务优先级。浏览需要的存储服务可由 Server 的账户数据服务提供；不得经由 Conversation 执行激活作为隐藏前置条件。

Workspace 摘要通道只发送已授权范围内的目录与活动摘要。详细观察必须逐 Conversation 显式建立，并受连接与资源预算约束。

“只读”只描述观察调用没有副作用，不描述用户角色。已获该账户操作权的任何端，在观察后无需申请控制权即可提交命令；仍需满足所有端一致的业务前置条件，例如任务仍可取消、请求仍待审批。

详细内容按 `(Account, Conversation, subscription window)` 发给所有匹配订阅者，与 origin 无关。命令回执返回发起该命令的请求者；命令产生的事实更新所有相关观察者。跨会话事件按实体身份入库，不替换客户端焦点、草稿或其他 Turn。

### 3. 统一命令与多端并发

Gateway 将已认证身份与捕获的 Workspace/Conversation/Turn/Task 目标送入既有准入，不依赖本连接的可变 active session 或历史 origin。不同端正常发送是两个 Query，复用同 Conversation mailbox/执行槽；网络重发使用同一幂等键，不以文本相同去重。

`cancel_turn` 保持精确当前 Turn 的原有语义。另增版本化 `cancel_task`，以不可变 Task 身份及执行代际为目标，经现有 Task cancellation fence 停止较旧 Turn 的后台/排队 Task。不得退化成“取消此会话最新任务”或 `/task clear all`。命令 accepted 和任务已停止分开展示。

所有端可读取同一份 pending approval 的必要详情并批准/拒绝；请求属于 Task/Attempt，而非发起设备。现有 AccountPermissionService/KernelWorkflow 扩展原子、持久、幂等的决定准入：第一个满足当前前置条件并持久提交的决定生效，相同重试复用结果，后到的相反决定返回已处理事实。崩溃恢复不得再次授权或丢掉已接收决定。

所有端最终呈现相同审批状态。审批提交只是用户决定，实际 capability grant 仍由现有 Kernel/Resource 契约生成；通知或 UI 不拥有执行授权。具体事务边界、取消竞态和恢复规则见详细方案 §12。

### 4. 通知目的地与操作权分离

origin 可提供默认回复位置并保留审计归因，但不能过滤观察、停止或审批。NotificationRoute 表达“把哪些任务的哪些通知送到哪里”，不是 Task owner。

Feishu 可以选择并跟踪 Web/TUI 发起的会话，查看历史/结果、接收进度、发送、停止和审批。卡片或文本命令实现与其他端相同的动作；仅提供跳 Web 链接不算完整 Feishu 支持。平台频率/卡片能力只影响展示形式，不能降级业务权限。

主动通知仅发送到已有合法目的地或用户明确跟踪的 chat/thread，避免所有任务自动刷屏。原飞书任务的通知目的地不会因用户在 Web 查看/操作而被改写；飞书主动跟踪一个 Web 任务也无需改变其 Conversation 归属。

结果对象的可读/完整、Kernel 认证、客户端观察确认和外部通知送达分别记录。各通知目的地独立幂等和重试，一处读取或送达不能错误地宣布所有目的地已交付。

### 5. 一致、可重建、有界的读模型

Application Shell 拥有读投影协议、纯投影规则和查询 port；Storage 实现索引、事务和 checkpoint；Gateway 负责身份、订阅与传输；客户端仅消费投影。TaskView、领域事实、不可变 ResultObject、事件日志和计费记录继续是各自权威。

按 Conversation 维护可重建的投影 `epoch/revision`。实体更新、投影 head、对应变化记录和 source checkpoint 在同一读模型事务提交。源数据跨 SQLite 与分段日志时，使用可恢复的持久变更来源与独立 source checkpoints，不能伪造跨系统原子提交。

客户端 cursor 指向投影 revision，不将经过过滤的 journal sequence 当成连续客户端序列。先注册观察、读取一致 revision 的有界基线，再补发该 revision 后的变化；重复幂等，缺口或预算溢出显式 reset。存储尚未追平时返回 freshness 状态，后台修复；禁止在每次切换请求中同步全量重放。

历史摘要、正文、轨迹、产物和账单分资源加载，分页同时约束条数和字节。超大单条结果通过正文引用和块读取处理，不能绕过首屏硬预算。当前任务基线覆盖全部非终态 Task，超出预算显式分页，不能只取最后一个 Turn。

2026-10-03 展示澄清：分页和正文块读取是资源传输契约，不要求用户点击阅读全文。Web 对话页保留原执行、报告与费用卡片，已挂载消息自动恢复全文，卡片资源独立自动补齐；不新增默认活动任务条或搜索行。Turn 数量、传输与缓存有界，单条全文 DOM 不承诺固定上限。

### 6. 客户端生命周期独立

Web 按身份范围、Conversation、Turn、Task、Subtask、Attempt、Result 建立规范化实体仓库，按实体订阅。客户端焦点、阅读位置、草稿、待确认命令、观察连接和后台执行分别管理。

切换首先恢复缓存与视口，随后异步 revalidate/follow。关闭面板只释放观察引用；最后一个观察者离开也不取消执行。缓存和 DOM 都有预算；不以无限 keep-alive 换取切换速度。

执行阶段、Turn 状态、数据新鲜度、结果交付、完成认证和命令可用性独立展示。执行阶段复用 TaskView。恢复审批列表与任务控制不需要旧连接存活，不为每个端启动独立 Planner 或 Runtime。

### 7. 版本与交付门槛

在现有 Gateway v2 envelope 上新增显式版本的观察、统一控制和 pending approval 能力；旧命令不隐式改变目标含义，新动作/请求字段用独立的版本化 schema。若必须改变 envelope 不变量，则在实施前提升协议主版本。

Web、Server、单一 TUI 和 Feishu adapter 协调发布并做能力对等测试。缺少能力是版本不匹配，不是“该端只能只读”。正式切换后移除 origin 内容过滤与来源端专属 UI 门禁，不保留旧限制作为默认 fallback。shadow 只校验，不双写业务事实或重复发送通知。

## Alternatives considered

| 选择 | 不采用的原因 |
| --- | --- |
| 只增加缓存和 loading | 可以临时改善热切换，但冷加载、重连与并行观察的结构问题仍在 |
| 保留 origin 独占，只给其他端只读观察 | 不满足用户要求的同账户跨端查看与控制 |
| 对所有连接/飞书群广播全部事件 | 无需观看的内容占用资源，且把通知目的地与操作权混为一谈；应按已授权订阅和通知路由分发 |
| 每个会话设置独占控制端、切换前抢占 | 对同一操作者增加无必要的接管步骤，断线会阻塞其他端 |
| 所有会话 DOM 常驻、全部持续 follow | 数据、订阅、Markdown 与 DOM 成本随使用时间增长 |
| 每次打开用全量 replay 恢复 | 将可预计算成本放到用户点击的关键路径 |
| 迁入 DeepSeek 的完整插件平台 | 与当前升级目标无关，扩大核心和发布边界 |

## Consequences

收益是任意端均可继续管理同账户任务，浏览不受执行激活和全量历史折叠阻塞，历史读取成本和浏览器资源可控。代价是统一跨端身份/目标、持久审批仲裁、通知路由、可重建读模型及预算管理；必须用故障注入验证重复操作、冲突、恢复和撤销。

本 ADR 现已接受。ADR-0036 保留在原路径作为已替代的历史记录，便于既有链接追溯；其持久历史、安全投影、定向通知要求由本 ADR 接管。ADR-0031/0035/0040/0041 的修订与 authority matrix、`CONTEXT.md`、current technical overview 一起记录。接受设计不等于宣布所有实施和发布门已通过；逐项证据见[本地实施记录](../plans/2026-10-02-frontend-observation-implementation.md)。

## Acceptance

详细方案中的正确性、性能、隔离、真实生产装配和安装版本验收全部完成，才可声明架构升级交付。仅文档、mock 基准或源码构建通过都不足以证明用户安装环境已经升级。

必须覆盖 Web/TUI/Feishu 之间全部九种“发起端 × 操作端”组合：历史、实时、发送、停止、审批的规则一致。两个端相反审批只产生一个决定；一个端离线不妨碍另一端继续操作；第三方消息重试不重复命令，通知目的地不因跨端浏览或控制漂移。
