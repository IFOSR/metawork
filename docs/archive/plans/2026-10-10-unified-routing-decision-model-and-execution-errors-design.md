# 统一智能体与模型路由、决策模型配置及执行错误可观测性设计

- 日期：2026-10-10
- 状态：已实施，本地验证完成，Release DMG 待用户验证
- 范围：Planner 意图与 DAG、AgentClass/Model 联合路由、决策模型设置、Workspace 执行前检查、错误分层、附件与截图可见性

## 1. 背景与问题

这次方案合并三个相互关联的问题：路由职责不清、决策模型不可由用户选择，以及执行失败时用户看不出失败发生在哪一层。

当前 Planner 的 Skill 中写入了部分业务路由规则，例如天气优先日常助理、研究任务优先分析师。这样会让 Skill 代替决策模型承担产品策略，也会在 Skill、AgentClass 职责和模型实际能力发生变化时产生冲突。现有 `SpanRoutingAdvisor` 只能在 Planner 已经提交的候选中排序，不能真正选择 AgentClass。因此“今天上海有雨吗？”可能被送到分析师，用户无法理解选择依据。

此前客户选择 `/Users/jialundu` 作为 Workspace。该目录同时包含 MetaWork 的运行目录 `/Users/jialundu/.metawork`。Executor 导入普通目录时在 `workspace-store` 下创建 `plain-import-*` 临时目录，临时目录落在源 Workspace 内部，形成自包含复制。系统实际在启动 Executor 前已经拒绝了这次导入，但异常沿普通 Attempt 链路被归类为 `unknown_executor_failure`，最终只显示为 `unknown requires explicit recovery`。用户因此需要额外诊断才能知道是 Workspace 配置问题，且容易误以为 Executor 已经执行并产生了外部副作用。

## 2. 目标与非目标

### 2.1 目标

1. Planner 负责理解用户意图、判断动作类型、拆解 DAG、声明能力和验收条件；不通过 Skill 写死 AgentClass 选择。
2. 一个决策模型在 Planner DAG 之后联合选择 AgentClass 和 Model。它可以选择 Planner 没有预先指定的合法 AgentClass，也可以在该 AgentClass 下选择最合适的 Model。
3. Candidate Builder 只根据硬约束生成合法候选，决策模型只在合法候选内做选择，Kernel 保留最终校验和授权权。
4. 决策模型复用用户已经配置的 Provider/Model，允许用户选择主模型和备选模型，配置方式与智能体配置一致，并纳入现有草稿和“保存并激活”流程。
5. Workspace 在选择、切换和每次真正执行前完成快速、确定性的自包含检查，避免把可预防的配置错误拖到 Executor 阶段。
6. 所有客户端看到同一套阶段、稳定错误码、是否启动 Executor、是否产生外部副作用和下一步动作。
7. 用户发送截图或附件后，能在对话消息中立即确认资源已经上传、正在处理或上传失败，不再只能看到一段没有附件标识的文字。

### 2.2 非目标

- 决策模型不重新理解完整用户意图，不取代 Planner。
- 不新增权限、AgentClass、Model 或工具能力。
- 不恢复生产语义请求的 `direct_reply`。Planner 可以判断“直接回答、控制命令、执行任务、需要澄清”等动作类型，但实时天气等需要外部数据的语义请求仍必须由 Executor 获取数据后回答。
- 不默认支持把账户根目录或包含 MetaWork 运行目录的 Home 目录作为 Workspace。
- 本文档定义设计和迁移边界；实现代码与本方案同步交付，并以本文末尾的验证记录为准。

## 3. 目标架构与职责

请求的主链路如下：

```text
用户输入
  ↓
Planner：理解意图、判断动作、拆解 DAG、声明能力
  ↓
Candidate Builder：生成所有硬约束合法的 AgentClass + Model 候选
  ↓
Routing Decision Model：联合选择 AgentClass + Model
  ↓
Kernel：校验 revision、权限、资源和执行前置条件并授权
  ↓
Executor：执行 Subtask，产出结果和证据
```

### 3.1 Planner

Planner 输出 Intent Graph。每个 Subtask 至少声明目标、依赖、`requiredCapabilities`、交付类型、验收标准、是否需要外部工具和可接受的资源约束。Planner 可以决定这是控制命令、需要澄清的请求，还是需要创建 Work Graph 的执行请求；它不能把自己的 Skill 规则当作最终路由结果。

Planner Skill 只规定协议、安全边界、输出格式和禁止事项。Skill 中不再写“天气必须用日常助理”或“研究必须用分析师”这类业务选择规则。这样 AgentClass 职责或模型目录变化时，决策模型可以读取最新事实重新判断。

Planner 仍可以处理少量不需要执行的控制请求，例如查询状态或停止任务。生产语义请求不能通过历史 `direct_reply` 绕过执行链路。

### 3.2 Candidate Builder

Candidate Builder 是确定性组件，不调用 LLM。它根据同一配置 revision：

- 找到满足 Subtask 能力要求的启用 AgentClass；
- 展开每个 AgentClass 允许使用的 ModelPolicy；
- 过滤 Provider、Model、Harness、权限、工具协议、上下文、结构化输出、图像输入、健康、容量、预算和 Workspace 等硬条件；
- 为每个组合生成稳定的候选 ID 和 fingerprint。

它输出完整候选集及过滤原因。候选集为空时直接返回可操作的配置错误，不调用决策模型。

### 3.3 Routing Decision Model

决策模型的输入包括：

- Planner 的 Intent Graph、Subtask、依赖、交付类型和验收标准；
- 所有硬约束合法的 AgentClass + Model 组合；
- AgentClass 的职责、适用任务、限制、工具和权限事实；
- Model 的能力、上下文、成本、延迟、优点和限制；
- 当前 Provider、健康、容量和预算事实；
- 路由策略版本、候选 fingerprint 和配置 revision。

输出包括每个 Subtask 的 `agentClassRef`、`modelRef`、备选顺序、结构化理由、置信度/不确定性、决策模型版本和输入 fingerprint。输出只能引用候选集中的身份，不能创建未配置的 AgentClass 或 Model。

决策模型只负责选择，不负责授权。Kernel 必须重新检查 revision、能力、ModelPolicy、Provider、Model、Harness、权限、健康、容量、Workspace 和成本。决策结果失效时，Kernel 可以采用仍然合法的备选或确定性 fallback，并把原因记录到 decision ledger。

### 3.4 调用时机与耗时控制

决策模型不在每个请求的每个阶段重复调用：

1. Planner 每个语义 Turn 仍生成一次 Intent Graph，这是理解请求和建立 DAG 所必需的。
2. Candidate Builder 是本地确定性检查，可在内存中完成，不发起模型请求。
3. 候选只有一个时，直接绑定该候选并记录 `single_candidate`，跳过决策模型。
4. 候选多于一个，或用户明确要求质量/成本/延迟取舍时，才调用一次决策模型为当前 Graph 生成绑定。
5. 同一 Graph 的重试、恢复和客户端刷新复用已持久化的决策；只有 Graph revision、候选 fingerprint 或路由策略变化时才重新决策。
6. 决策模型超时或不可用时，使用经过 Kernel 校验的确定性 fallback，并清楚标记“自动回退”，不把故障伪装成普通 Agent 执行失败。

## 4. Work Graph 契约

Planner 产物和路由产物分开保存：

- **Intent Graph**：目标、Subtask、依赖、能力要求、交付和验收，不含最终 AgentClass/Model 绑定。
- **Resolved Routing**：每个 Subtask 的最终绑定、合法候选摘要、候选 fingerprint、决策模型版本、配置 revision、理由、备选和 fallback 记录。

历史提案继续保留具体绑定用于审计和重放。迁移期间旧 `executorBindings` 可以作为兼容输入，但新的 Planner 不能用它缩小合法候选集。已经开始执行的 Graph 固定其 revision；切换决策模型只影响后续新 Graph。

## 5. 决策模型配置与 Provider 复用

决策模型属于系统路由能力，使用现有 Provider/Model 目录，不再维护独立的 OpenRouter API Key。Provider 保存 Base URL 和密钥引用，Model 目录保存模型及其公开参数；路由设置只保存 Provider/Model 引用，凭证仍由 SecretStore 管理。

### 5.1 可选模型条件

在模型目录增加系统能力标识 `routing-decision`。只有满足以下条件的模型才出现在决策模型选择器：

- Provider 已启用且凭证有效；
- Model 已启用；
- 支持可靠 JSON 或结构化输出；
- 上下文长度满足候选和任务事实的上限；
- 支持 MetaWork 路由协议；
- 价格和限额状态可解释；
- 探针或最近健康状态可用。

每个账户保存一个主决策模型和零到多个有序备选，并保存协议版本、超时、输入大小和候选数量限制。主模型缺失时状态是“配置未完成”，不能显示成“已启动但不可用”。对于需要语义路由的执行配置，必须有有效主模型或明确的系统确定性 fallback。

### 5.2 UI 设计

设置页将旧的“决策模型 开启/关闭”卡片改为与智能体配置同层的“系统路由”卡片：

```text
系统路由                                           配置未完成 / 可用

主决策模型
  Provider        [选择已配置 Provider]
  Model           [选择具备 routing-decision 能力的模型]

备选模型（可选）
  1. Provider / Model                         [调整顺序]
  2. Provider / Model                         [删除]



状态：凭证有效 · 最近探针时间 · 失败阶段（如有）
                         [保存并激活]
```

交互规则：

- 先选 Provider，再从该 Provider 中筛选具备 `routing-decision` 的 Model。

- 没有可选模型时，提示先在 Provider 中添加或刷新模型；不显示一个无法工作的开关。
- 凭证缺失、模型不支持结构化输出、探针失败分别显示具体原因和修复入口。
- 复用现有配置草稿、校验、保存并激活、revision 和回滚流程。
- 决策模型不是可执行 Workspace AgentClass，也不出现在智能体职责列表中。
- 变更提示“只影响后续新 Graph”；已运行和已持久化的 Graph 继续使用原 revision。

## 6. Workspace 执行前检查

Workspace 选择或切换时，服务端对路径做 canonical/realpath 解析并检查：

- 路径不能等于账户运行根目录；
- 路径不能包含账户运行根目录，也不能位于账户运行根目录内；
- 路径不能等于或包含 `workspace-store`；
- 符号链接解析后的路径同样检查；
- 路径必须是可访问的具体项目目录。

例如选择 `/Users/jialundu` 时立即提示：

> 不能使用此目录作为 Workspace。它包含 MetaWork 运行目录 `~/.metawork`。请选择具体项目目录，例如 `~/Projects/my-project`。

首次执行、重试、定时唤醒、恢复和重新派发必须经过同一条 preflight：

```text
解析 Task → Workspace ID
→ canonicalPath
→ Account/Workspace 归属
→ 运行目录包含关系
→ 权限和路径类型
→ 创建托管 Git/Attempt Workspace
→ 持久化 preflight 结果
→ 启动 Executor
```

缺失 Workspace 时禁止静默回退到 `workspace-store`。Workspace preflight 失败时不得创建 Attempt，也不得启动 Executor。

## 7. 错误阶段、稳定错误码与用户提示

### 7.1 错误分类

| 阶段                    | 错误码                               | 含义                         | 自动重试   |
| --------------------- | --------------------------------- | -------------------------- | ------:|
| `workspace_preflight` | `workspace_contains_runtime_root` | Workspace 包含 MetaWork 运行目录 | 否      |
| `workspace_preflight` | `workspace_binding_missing`       | Task 没有有效 Workspace 绑定     | 否，要求修复 |
| `workspace_preflight` | `workspace_path_invalid`          | 路径不存在、类型不对或无法解析            | 否      |
| `workspace_preflight` | `workspace_transient_unavailable` | 临时不可访问                     | 有限重试   |
| `dispatch_preflight`  | `dispatch_context_invalid`        | 调度身份、revision 或资源上下文无效     | 否      |
| `executor_start`      | `executor_process_start_failed`   | 已通过前置检查，但进程启动失败            | 按进程策略  |
| `execution`           | `unknown_executor_failure`        | Executor 已启动，外部副作用无法确认     | 显式恢复   |

`unknown_executor_failure` 只能用于 Executor 已经启动且无法确认外部副作用的情况。Workspace 自包含错误不能再归类为 unknown，也不能要求用户执行 recovery。

### 7.2 结构化错误事实

每次失败至少持久化：

```text
stage
code
summary
detail
retryable
attemptStarted
externalSideEffect
userAction
accountId
conversationId
turnId
taskId
subtaskId
attemptId
configurationRevision
```

`failure-reasons.ts` 中的字符串匹配只作为旧数据兼容层。新错误必须从产生阶段开始携带稳定 code，Web、TUI 和 Feishu 共享同一错误目录和投影。

### 7.3 三层呈现

第一层给出一句结论：

> 无法开始执行：Workspace 配置无效。

第二层说明原因和动作：

> 当前 Workspace `/Users/jialundu` 包含 MetaWork 运行目录 `~/.metawork`。系统在 Executor 启动前停止了任务。下一步：选择具体项目目录后重新提交请求。Executor 是否启动：否。是否产生外部副作用：否。是否需要执行 recovery：否。

第三层提供可展开的技术详情：

```text
阶段：workspace_preflight
错误码：workspace_contains_runtime_root
Attempt：未启动
retryable：false
Task：...
Subtask：...
Configuration revision：...
```

这样用户可以直接修复问题，支持人员也能从轨迹中判断失败发生在 Workspace、调度、进程启动还是执行阶段。

## 8. 对话中的截图与附件可见性

### 8.1 问题与设计原则

当前上传链路已经保存附件并把 `attachmentId` 交给 Planner，但对话中的用户消息只投影文本，截图或普通文件没有留下可见的资源卡片。用户因此无法确认粘贴是否成功，也无法区分“已上传但尚未执行”和“根本没有上传”。

附件展示属于 Conversation 消息的表现层，不改变现有附件资源契约：原始文件仍由 MetaWork 保存，Planner 只接收安全元数据和引用，Executor 只读取被授权的 attempt-local 输入。消息投影不得展示服务器绝对路径、内部存储目录、访问令牌或文件内容之外的敏感元数据。

### 8.2 发送前的 Composer 状态

用户点击回形针、拖放文件或粘贴截图后，Composer 立即创建一个本地资源条目，并按以下状态更新：

| 状态          | 展示                        | 用户动作                 |
| ----------- | ------------------------- | -------------------- |
| `uploading` | 预览缩略图或文件图标、文件名、大小、上传进度/转圈 | 可取消；不能把尚未落库的资源宣称为已发送 |
| `available` | 缩略图或类型图标、文件名、大小、已上传标识     | 可移除、预览；允许发送          |
| `failed`    | 文件图标、文件名、失败原因             | 重试或移除；文本草稿仍保留        |
| `cancelled` | 从待发送列表移除，并保留必要的撤销提示       | 可重新选择或粘贴             |

上传未完成时，发送按钮应明确提示“附件仍在上传”，而不是静默丢弃附件。若产品需要允许先发送文字，则必须将该消息保存为“附件未随本次发送”，并明确显示；默认采用等待上传完成后发送，避免产生歧义。

### 8.3 已发送消息的附件卡片

用户消息气泡保留原有文本，同时在文本下方显示附件区域。每个附件至少显示：

- 截图/图片：缩略图、图片类型图标、文件名或“截图”、尺寸；点击打开受权限保护的预览。
- 普通文件：文件类型图标、文件名、大小、类型；点击打开预览或下载入口。
- 多个附件：显示前两个或三个卡片及“还有 N 个附件”，展开后查看完整列表。
- 上传成功但尚未开始执行：显示“已上传”，不要显示“处理中”以免误解为 Executor 已经启动。
- 上传失败或引用失效：保留消息中的附件占位卡，显示“上传失败/附件不可用”和重试或重新上传入口；不能把附件静默从历史消息中删除。

建议的消息形态如下：

```text
用户：帮我看看这张截图里的报错

┌──────────────┐  screenshot.png  1.2 MB   已上传
│   图片缩略图  │  点击查看大图
└──────────────┘
```

文件名来自安全的用户可见元数据。展示层不把 `attachmentId` 当作文件名，也不展示本地绝对路径。截图没有可靠文件名时，使用“截图 2026-10-10 14:32”这类可读名称，并保留原始 MIME 和大小供详情查看。

### 8.4 事件、历史回放与多端一致性

发送成功的用户消息事件必须同时携带文本和有序附件摘要，或引用同一条持久化消息附件记录。历史分页、刷新、Server 重启、切换 Conversation 和重新连接后，都从持久化事实重建同样的附件卡片，不能只在发送瞬间依赖浏览器内存。

Web、TUI 和 Feishu 使用同一套附件元数据和状态语义：Web/TUI 展示缩略图或类型图标，Feishu 在不支持缩略图的场景显示“图片 1 张”或文件名、大小及可用的预览/下载入口。附件卡片与正文分离，避免把二进制内容拼入 Planner 输入或历史文本。

附件卡片的状态更新应是幂等的，并按 `conversationId`、`turnId` 和 `attachmentId` 绑定，防止切换会话或异步上传完成后把附件显示到另一条消息。删除草稿附件只影响未发送资源；已发送消息的附件记录保持可回放，除非执行明确的删除/过期策略。

### 8.5 可访问性与异常提示

- 图片缩略图提供替代文本，例如“用户上传的截图 screenshot.png”；文件图标不能是唯一信息来源。
- 键盘可聚焦附件卡片，Enter/Space 打开预览，Esc 关闭预览；上传进度和失败状态使用可读的状态文本。
- 缩略图加载失败时回退到图片图标、文件名和“预览不可用”，不影响消息正文。
- 资源被删除、过期或无权限时显示“附件不可用”，说明原因和可行操作，不显示内部存储错误。
- 附件上传失败要与 Planner、Kernel 或 Executor 失败分开显示；它属于上传/资源阶段，不能被归类为 `unknown_executor_failure`。

### 8.6 验收标准

- 粘贴截图后，Composer 立即出现缩略图和上传状态；上传完成后可以明确看到“已上传”。
- 发送包含截图的消息后，用户消息气泡始终显示截图卡片；普通文件显示类型图标、文件名和大小。
- 刷新页面、重新连接、切换客户端和历史翻页后，附件卡片仍存在且顺序一致。
- 上传中、上传失败、附件不可用、预览失败分别有独立状态和下一步动作，文本消息不被静默丢失。
- 附件展示不暴露绝对路径、Secret、内部目录或未授权内容；点击预览/下载经过现有授权检查。
- 发送的附件引用与 Planner Turn、Work Graph 和 Executor 输入保持同一 `attachmentId`，展示层不创建第二份资源身份。

## 9. 迁移和实施阶段

### Phase 0：契约与记录

- 定义 Intent Graph、Resolved Routing、候选 fingerprint、`routing-decision` 能力和稳定错误码。
- 更新 Planner 输出协议和 Skill 边界，保留旧字段读取兼容。

### Phase 1：联合路由

- 实现 Candidate Builder、决策模型输入/输出协议、Kernel 复核和 decision ledger 持久化。
- 增加单候选跳过、超时 fallback、revision 固定和重放规则。

### Phase 2：Provider 化决策模型设置

- 复用 Provider/Model 管理和 SecretStore。
- 实现系统路由卡片、主/备选模型、能力筛选、探针、保存并激活和错误状态。

### Phase 3：Workspace、错误与附件可观测性

- 在 Workspace 选择、切换和所有派发入口接入 canonical preflight。
- 禁止自包含导入和 `workspace-store` 回退。
- 统一错误目录、事件、TaskView、Web/TUI/Feishu 三端投影。
- 在 Conversation 消息投影中加入持久化附件摘要、缩略图/类型图标和上传状态；统一历史回放、重连和多端展示。

### Phase 4：验收

- “今天上海有雨吗？”在多个合法候选中由决策模型选择日常助理类；研究报告和原因分析选择分析类。
- 决策模型能选择 Planner 未指定但候选合法的 AgentClass，并在其下选择 Model。
- 单候选不调用决策模型；同一 Graph 重试复用已持久化决策。
- `/Users/jialundu` 在选择时直接被阻止；自包含导入不再显示 unknown recovery。
- Workspace 缺失、权限失败、暂时不可用、Executor 启动失败和 Executor 崩溃分别展示阶段、错误码和动作。
- 轨迹能看到决策模型、候选 fingerprint、配置 revision、失败阶段、Executor 是否启动和外部副作用状态。
- 截图和普通附件在发送前、发送后、历史回放和上传失败时都有清晰的可见状态，且不泄露内部路径。

## 10. 评审结论需要确认的事项

1. 是否接受 Planner 只产出 Intent Graph，AgentClass/Model 选择统一下沉到 Candidate Builder + Routing Decision Model。
2. 是否接受决策模型直接复用 Provider/Model，并取消独立的启用/关闭开关。
3. 是否接受“候选单一时跳过模型、多候选时调用一次、重试复用决策”的耗时控制策略。
4. 是否接受 Workspace 自包含路径在选择阶段阻止，以及将其从 `unknown_executor_failure` 中分离。
5. 是否接受在用户消息中持久化展示附件摘要、截图缩略图/文件图标和上传状态，并由 Web、TUI、Feishu 共享同一附件状态语义。

## 11. 实施记录（2026-10-10）

已完成：

- Provider/Model 可配置的系统路由决策模型，支持主模型、备选模型、结构化输出和配置 revision；旧版固定 OpenRouter 配置仍可读取。
- Planner 可以只声明 `requiredCapabilities`；Candidate Builder 在缺少旧式 `executorBindings` 时枚举启用且满足硬约束的全部 Executor AgentClass，Kernel 重新校验并授权最终绑定。
- 决策模型只在多候选 Subtask 上调用，单候选直接使用；同一 Graph 的重试和恢复沿用已持久化 revision，Advisor 在主模型失败时按顺序尝试备选模型。
- Workspace 选择以及首次执行、重试、恢复和重新派发前执行 canonical/realpath preflight；自包含路径和缺失 Workspace 使用稳定错误码，并投影阶段、Executor 是否启动、外部副作用和用户动作。
- Web 对话消息显示图片缩略图、普通文件卡片、上传中状态和不可用状态；附件预览接口经过会话授权校验。

验证记录：

- `npm run lint -- --pretty false` 通过。
- 路由、Planner、Kernel、Gateway、Workspace、错误投影和 Web 相关 Vitest focused tests 通过；桌面 16 项测试通过。
- `npm run build`、`npm run build:web`、`npm run lint:desktop` 通过。
- Electron production-assets smoke 通过，Server 在 Electron 退出后保持运行。
- 本地 Apple Silicon 内部 DMG：`apps/desktop/release/MetaWork-darwin-arm64.dmg`，488835202 字节，SHA256 `e5580e8dd2a1fc0c6c6c09528ed027fd78a9dc03b241d4eb5ab0af5524f06cae`。未发布或推送 GitHub，等待用户安装验证。

## 12. 决策模型传输修复（2026-10-11）

现场验证发现，Drex 部署在本地 llama.cpp Provider 时，MetaWork 将 SDK
调用层的 `decisionsRequest` 封装误当成 HTTP body 发送，Provider 因此返回
`400 request needs state and questions`，UI 只能显示“决策模型返回异常”。
修复后自定义 Provider 的 `/systemone` 请求使用顶层 `model`、`state`、
`questions` 字段；同时兼容本地 System One 返回的 `input_tokens` 和
`output_tokens` 用量字段。OpenRouter SDK 路径保持原有调用方式。

真实接口回归返回 HTTP 200，并通过完整候选概率校验：`c000=0.7754`、
`c001=0.2246`。专项路由、会话、准备阶段、烟测和端到端测试共 83 项通过，
主构建通过。

修复后的 Apple Silicon 内部 DMG：
`apps/desktop/release/MetaWork-darwin-arm64.dmg`，524155984 字节，
SHA256 `c7dc1af8125e72e7cadbf3df39a738deb74ad349b41734c8f716c2e7df3afec9`，
内置版本 `0.1.13`，releaseId `0.1.13-internal-routing20261011`。该包未发布
或推送 GitHub，使用内部 ad-hoc 签名。
