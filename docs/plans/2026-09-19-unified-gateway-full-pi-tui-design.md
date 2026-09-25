# MetaWork 统一 Gateway 完整 Pi TUI 详细设计

> Status: 已实施（阶段 B/C/D/E 完成，阶段 F 见 §18.3 验收记录）
> Design date: 2026-09-19
> Scope: 唯一原生 TUI、Pi 展示组件复用、Gateway 安全投影、旧 TUI 退役
> Governing decisions: ADR-0020、ADR-0031、ADR-0032、ADR-0034、ADR-0035、ADR-0036、ADR-0037、ADR-0040、ADR-0041
> Implementation status: 阶段 B/C/D/E 已交付（见 §18.3）；阶段 F 已完成可执行项并标注未验证项
> Required decision update: 已由 ADR-0041 记录单 TUI 收敛与只读 Gateway 扩展决定

## 1. 结论与目标

MetaWork 最终只保留一个产品 TUI：以此前迁入的 Pi 完整界面组件为基础，
提供完整编辑器、主题、对话展示、Task Dashboard 和原生终端交互；
运行定位仍然是 Gateway Client，不是本地 PlanningAgent。

`metawork` 与 `metawork tui` 的命令名称、独立客户端生命周期不变。
替换的是命令后面的界面实现，不是 Server/Client 架构。

三个交互端遵守同一个逻辑边界：

```text
Web UI ------------------ HTTP / WebSocket --------+
Feishu 用户 -> 平台 -> Server-owned Feishu Adapter -+-> ClientGateway
完整 Pi TUI ------------- Unix Gateway ------------+       |
                                                           v
                                                   Application Shell
                                                   AccountRuntime
                                                   ConversationSession
                                                           |
                                               Planner / Kernel / Execution
                                                           |
                                                     Durable facts
```

统一的是身份、命令语义、安全事实、历史和业务状态，不是 UI 组件、网络传输、
卡片格式或进程部署。飞书适配器仍由 Server 管理，不新增独立飞书进程。

交付后的强约束：

1. 用户只能进入这一套 MetaWork TUI，不保留 simple/full/standby 三套模式。
2. TUI 不创建本地 AgentSessionRuntime，不执行模型调用，不管理 Pi 会话文件。
3. 所有业务操作经 Gateway；所有业务状态来自 Server。
4. Web、Feishu 的现有交互和交付行为不得因 TUI 改造退化。
5. Pi 服务端 RPC Planner 及 canonical Executor CLI 的运行能力不受删除影响。

## 2. 依据与当前代码事实

本文以 2026-09-19 工作树、起始提交 `3723377` 为调查基线。
代码及测试优先于旧计划中的实施描述。

| 现状 | 代码依据 | 设计影响 |
| --- | --- | --- |
| 裸命令解析为 TUI，Client 独立连接 Server | [CLI 参数](../../src/cli/args.ts)、[Client 入口](../../src/client/client-command.ts)、[启动器](../../src/client/tui-client-launcher.ts) | 保留入口与 endpoint 校验 |
| Gateway 参数命中后进入简版客户端，不进入完整 InteractiveMode | [Pi main](../../planner/AnyFusion-Pi/packages/coding-agent/src/main.ts) | 替换 Client 呈现与编排，不切回旧运行分支 |
| 简版已有 Gateway transport、命令、重连和 reducer | [GatewayClient](../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.ts)、[客户端模式](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts) | 可复用，但不是已经满足完整界面的终态实现 |
| 旧完整界面直接依赖 AgentSessionRuntime、session.prompt、SessionManager | [InteractiveMode](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts) | 不允许直接恢复或用假 Session 包装 |
| 原编辑器本身依赖 TUI 与键位映射 | [CustomEditor](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/components/custom-editor.ts) | 优先提取为可复用组件 |
| 旧 Dashboard 使用 schemaVersion 1 的 Planner Host snapshot | [Task Dashboard](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/components/anyfusion-task-dashboard.ts) | 保留布局与交互，替换数据模型 |
| 简版模型主要保存 currentTurn/currentCommand；部分已知事件没有实质消费 | [模型](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-model.ts)、[reducer](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-reducer.ts) | 需要补齐多 Turn 历史、任务投影、产物和权限生命周期 |
| Server 已有历史查询命令，TUI GatewayClient 尚未完整暴露 | [Gateway 命令](../../src/gateway/client-protocol.ts) | 扩展客户端 API，不发明第二套历史系统 |
| Server 已有命令补全语义，但当前 Gateway command union 未暴露补全 | [命令目录](../../src/commands/catalog.ts)、[ConversationSession](../../src/session/conversation-session.ts) | 通过 Gateway 暴露受限只读补全，不复制目录到客户端 |
| Ink 仍有源码和测试，旧 Gateway Ink adapter 仍引用它 | [Ink App](../../src/tui/app.tsx)、[旧 Gateway UI](../../src/gateway/client-ui.tsx) | 删除范围不只是 src/tui/ |
| 未发现当前 CLI 启用 Ink 的生产分支；启动脚本只清除 standby 环境变量 | [安装启动脚本](../../src/installation/native-launcher.ts) | 文档中的开关说明不代表可用生产路径 |

重要限制：代码存在不等于旧完整界面可以直接运行；已有 event kind 不等于它的
payload 足以驱动完整面板；已有测试通过也不等于实机终端体验已验收。

## 3. 范围与非目标

### 3.1 本次必须交付

- Pi 风格完整编辑器、补全、快捷键、主题与响应式终端布局。
- Workspace 与 Conversation 选择、创建、历史分页和重连回放。
- 按 Turn 组织的对话、Markdown 结果、系统命令输出和安全执行轨迹。
- Task Dashboard：选中 Turn 的 Task、Subtasks、Attempts、权限和产物状态。
- 稳定的取消、权限确认、提交回执和断线不确定性处理。
- 唯一客户端控制器、唯一展示状态模型、唯一组件树。
- 旧简版呈现、旧完整本地控制器、Ink 及其无用入口的退役。
- Web/Feishu 契约回归、Planner RPC 回归、native 终端验收。

### 3.2 本次不交付

- 不改变 Planner/Kernel/Execution 的语义、调度、恢复或存储职责。
- 不给 TUI 添加本地模型、工具、shell、外部扩展或配置写入权限。
- 不恢复 Pi 的本地会话分支、上下文压缩、steer/follow-up、Provider 登录等运行能力。
- 不重做 Web、飞书消息卡片或飞书投递重试策略。
- 不把 Web 专用管理、附件上传接口强行改成 Unix JSONL。
- 不增加跨端详细实时广播，不改变 ADR-0036 的 origin 规则。
- 不做新的远程客户端认证体系、通用插件框架或第二套事件总线。
- 第一版不承诺 TUI 图片粘贴、任意文件上传、文档预览、结果导出或剪贴板自动写入。
  这些能力需要独立的传输、授权与本地副作用设计，不能直接搬回 Pi 工具。

“完整”指本文列出的 MetaWork 终端交互体验，不是 Pi 独立 Agent 功能的全量复刻。
未提供的原生能力不显示成可点击但无效的菜单。

## 4. 方案比较与选择

| 方案 | 优点 | 代价或风险 | 结论 |
| --- | --- | --- | --- |
| 原样启用旧 InteractiveMode | 最快看到旧界面 | 恢复本地 Agent、会话与 Host 双通道，破坏当前边界 | 拒绝 |
| 保留简版模型，只增加边框、颜色和面板 | 初始改动小 | 历史、任务身份和事件消费缺口仍在，不是完整体验 | 拒绝 |
| 提取 Pi 展示组件，统一到 Gateway-backed TUI | 复用成熟终端能力，保留 Server 权威，最终只有一套 TUI | 需要组件解耦、投影补齐与删除验收 | 采用 |

不采用 `FakeAgentSession`、远程 AgentSession 仿真或向旧类注入大量空方法的办法。
这会把与当前产品无关的运行 API 固化为客户端接口，并留下隐蔽本地执行路径。

## 5. 职责与依赖方向

| 模块 | 唯一职责 | 禁止承担 |
| --- | --- | --- |
| Server / AccountRuntime | 业务事实、配置、Task、Kernel、执行、恢复、持久化 | TUI 布局、终端焦点 |
| Conversation Application Shell | 输入受理、Conversation 上下文、现有查询与安全投影 | 新的客户端语义路由 |
| ClientGateway | 认证、范围校验、版本化命令、定向事件与回放 | 渲染 UI、推断计划 |
| TUI GatewayClient / transport | 连接、发送、回执、订阅、重连与协议解析 | 业务重试策略、启动 Planner |
| TUI Controller | 将显式用户操作映射为命令，协调导航和 UI 生命周期 | 推断自然语言含义或修改 Task |
| TUI reducer / model | 从合法 Server 事实确定性构造只读展示状态 | 文件访问、网络请求、业务状态落库 |
| TUI components | 编辑、布局、Markdown、焦点、滚动、主题 | 调用 Gateway、Runtime 或 Repository |

允许的客户端依赖：

```text
TUI Controller -> GatewayClient -> Gateway transport / public protocol
TUI Controller -> reducer -> presentation model
TUI components -> presentation model / pi-tui primitives / UI preferences
```

禁止的客户端依赖包括 `AgentSessionRuntime`、`AgentSession`、`SessionManager`、
模型注册/认证实现、工具执行器、Planner Host、SQLite、Kernel、Executor 和
AccountRuntime 的运行实现。`import type` 也不用于把巨大运行接口伪装成客户端 port。

允许的本地状态只有 UI 偏好及进程内交互状态。主题和键位偏好可以独立保存；
默认不把草稿、结果、权限请求、Task 状态或完整 Conversation 历史持久化到客户端。
读取 endpoint manifest 和 UI 偏好不等于获得 Workspace 文件读取权限。

## 6. 源码布局与唯一入口

继续使用仓库内 `planner/AnyFusion-Pi` 与现有隔离依赖树，不迁入宿主 `src/tui/`，
不使用 host-global Pi 包，不改变 AnyFusion 的上游归属说明。

建议目标布局，均为拟新增或迁移后的路径：

```text
src/client/
  client-command.ts                 # 保留 canonical CLI
  tui-client-launcher.ts            # 保留 endpoint/版本/子进程管理

planner/AnyFusion-Pi/packages/coding-agent/src/
  anyfusion/
    gateway-client.ts              # 复用并完善，不另造 transport
    gateway-socket-transport.ts
    gateway-protocol.ts
  modes/metawork-tui/
    index.ts                       # 唯一 runMetaWorkTui 入口
    controller.ts                  # 用户动作及导航协调
    model.ts                       # 唯一客户端展示模型
    reducer.ts                     # live/history/replay 共用
    protocol-adapter.ts            # public payload 校验与归一化
    preferences.ts                 # 仅 UI 偏好
    components/                    # 从 Pi 提取并解耦的组件
    theme/                         # Pi 主题与终端颜色能力
```

这是物理落点建议，不是新增独立应用或发布包。已有组件迁移应保留 Git 可追溯性；
同一个组件不在新旧目录长期各保留一份。

入口规则：

1. `metawork` / `metawork tui` 继续通过 `TuiClientLauncher` 启动隔离客户端。
2. `--gateway-socket` 进入唯一新 TUI 入口；可选 Conversation 与 cwd hint 语义不变。
3. 客户端分支不加载运行时模块图；必要时把 `main.ts` 的运行路径改为按模式延迟导入。
4. 删除旧 `InteractiveMode` 的交互启动分支及不再需要的公开导出、专用测试。
5. vendored Planner 的无 Gateway 交互调用明确失败，不隐式启动独立 Agent TUI。
6. 服务端 `--mode rpc` 路径和仍被服务端消费的非交互能力继续存在。

“只有一个 TUI”约束 MetaWork 产品及此 vendored Planner 的交互入口，
不意味着删除用户机器上独立安装的 canonical Codex/Pi Executor 程序。

## 7. Pi 组件复用边界

| 原组件或能力 | 目标处理 |
| --- | --- |
| `TUI`、`ProcessTerminal`、`Container`、`Markdown`、文本与边框 | 复用 Pi 终端基础库 |
| `CustomEditor` | 提取键位、补全、粘贴与提交能力；回调改为客户端动作 |
| `AnyFusionPlannerWorkspaceComponent` | 复用对话/侧栏组合与宽度适配思路，消费新的 view model |
| `AnyFusionTaskDashboardComponent` | 保留 Task 面板体验；不再接旧 schemaVersion 1 snapshot |
| 主题 JSON 与主题切换 | 复用；主题控制器依赖独立 UI preference port |
| 用户消息、Markdown 显示 | 复用展示原语，输入改为安全公共消息结构 |
| 原 `AssistantMessageComponent` | 不直接传入原始模型消息；去除 thinking/toolCall 隐式展示路径 |
| 原 `ToolExecutionComponent` | 不整体复用，其依赖工具定义；改为安全进展组件 |
| 原 `FooterComponent` | 保留视觉组织，数据改为连接、Workspace、选中 Turn 和公开路由身份 |
| Pi Session selector/tree/fork | 替换为 Server Conversation selector 与历史 Turn 选择 |
| 本地 Provider/model 登录、设置、扩展与工具菜单 | 删除客户端入口；业务配置仍由已有管理面拥有 |

显示不了 token/context usage 时不补零、不读取 Planner 文件推算。
没有安全字段的数据明确显示“暂无信息”，并在验收中检查是否属于必须补齐的契约。

## 8. 交互与信息架构

### 8.1 主界面

```text
+-------------------------- MetaWork --------------------------+
| Workspace / Conversation                 连接状态 / UI 菜单  |
+---------------------------------------+----------------------+
| Conversation                          | Task Dashboard       |
|                                       | 选中 Turn / Task     |
| 用户请求                              | Task 状态            |
| 安全过程摘要，可展开                  | Subtasks             |
| Markdown 结果                         | Attempts / 权限      |
| 历史 Turn，可滚动                     | Artifacts            |
+---------------------------------------+----------------------+
| 当前操作状态 / 命令提示 / 取消与权限提示                       |
| 多行编辑器                                                   |
+--------------------------------------------------------------+
```

采用 Pi 现有视觉语言，不新增另一套终端 UI 框架。
默认标题为 MetaWork；内部协议名称与上游 attribution 不做无关重命名。

布局验收基准：

| 终端 | 布局 |
| --- | --- |
| 80x24 | 对话优先；Task 面板通过覆盖层或独立视图打开；保留输入和关键操作 |
| 120x36 | 对话与 Task 面板并列 |
| 160x48 | 扩展正文与详情宽度，不自动展开全部历史轨迹 |

尺寸低于基准时优先保留可退出、可恢复焦点的提示，不因负宽度或空视口崩溃。
窗口缩放不得丢草稿、改变选中 Task 或触发网络业务命令。

### 8.2 对话、历史与系统命令

- Conversation 按服务器确认的顺序组织多个 Turn，而非一个不断覆盖的 currentTurn。
- 用户请求、过程摘要、结果只各有一个明确位置，live 与 replay 不重复追加。
- 系统命令使用紧凑命令块，不伪造 Planner 的理解/执行阶段。
- 系统命令触发的后台 Task 仍根据 Server 明确关联展示；命令返回不等于任务结束。
- 历史分页使用已有 `get_conversation_history`，不得通过本地 Pi session 读取补历史。
- 到达新的进展时，若用户正在看历史，不强行跳到底部或切换选中 Turn。
- 用户可显式回到最新 Turn；历史不可用时保留明确缺失提示，不伪造已加载全部历史。

### 8.3 Task Dashboard

默认只展示选中 Turn 的 presentation Task：

```text
Conversation -> Turn -> Task -> Subtask -> Attempt
```

Task 与 Turn 的关联来自服务端，不按标题、列表顺序或最近更新时间猜测。
同一 Task 的多个并行 Subtask 必须同时可见；多个 Conversation 的任务不能混成
一个“当前执行器”。不把账户级历史阻塞任务自动插入当前 Turn。

面板展示任务摘要、可理解的状态、公共 Executor/Provider/Model/Harness 身份、
最近有效进展、运行时长、验证/发布状态、权限和产物。
旧 smoke audit、binaryPath 等诊断字段不因曾在旧面板出现就自动恢复。
账户级 Executor 信息可以通过现有只读系统命令查看，不新建客户端调度视图。

活动 Attempt 的时长由服务端开始时间与本地展示时钟计算；
结束后使用服务端完成时间冻结。客户端静默计时只能表示“多久没收到更新”，
不能判定 Executor 已失败、超时或需要重试。

### 8.4 编辑器与快捷键

- 保留多行编辑、历史输入导航、粘贴、补全候选及中文宽字符处理。
- Enter 提交；保留 Pi 可用的换行键位，帮助面板显示实际终端可识别的绑定。
- Tab 在编辑器中处理补全；焦点切换使用独立键位，不能劫持正常文本输入。
- Escape 优先关闭候选/弹层；业务取消必须经明确的当前 Turn 操作，不直接 kill 进程。
- Ctrl+C、Ctrl+D 或 `/exit` 只退出客户端，不隐式取消 Server 工作。
- 权限快捷键只在显式权限面板获得焦点后有效；普通输入中的 `a`、`x`、`c`
  永远不能自动变成允许、拒绝或取消命令。
- 主题、面板展开、帮助和焦点操作是本地 UI 动作；业务 slash command 始终提交 Gateway。
- 用户连续编辑期间，异步补全结果必须匹配输入版本与 scope；旧响应不能覆盖新草稿。

本地 UI 动作优先用菜单/键位表达，避免与服务器已有 slash 命令重名。
`/workspace`、`/conversations` 等既有导航交互保持可用，由 Controller 映射到现有命令。

### 8.5 提交、取消与权限

提交瞬间固定 Account/Conversation/Workspace 目标，不从随后变化的选中项重新取值。
本地待发送消息以 `requestId` 关联；回执仅更新“已受理/重复/拒绝”，不能推断 Task 已运行。

取消使用 `cancel_turn`，遵守 ADR-0040：
按钮先显示“正在请求取消”，收到权威状态后显示取消结果；不使用 `/task clear all`
替代，不把命令 receipt 当作物理 Executor 已退出的证明。

权限面板仅发送请求 ID 与 approve/deny，范围由 Server 决定。
请求过期、被其他端处理、历史重放或 scope 不符时禁用旧操作并刷新事实。
展示快照中的历史请求不能自动恢复为有效授权请求。

## 9. Gateway 契约与缺口收敛

### 9.1 已有命令继续使用

`select_workspace`、`list_workspace_conversations`、`create_conversation`、
`attach_conversation`、`archive_conversation`、`get_conversation_history`、
`user_message`、`slash_command`、`permission_resolution`、`cancel_turn`
仍属于 [统一 Gateway 命令](../../src/gateway/client-protocol.ts)。

TUI 按需补充缺少的客户端方法，不引入 Pi 专用业务命令集。
客户端传入的 ID 和路径都是请求，不是权限证明。

### 9.2 必须消费的事实

| 展示能力 | 现有来源 | 本次处理 |
| --- | --- | --- |
| Workspace/Conversation 目录 | workspace 系列事件 | 保留；处理分页、scope 和异步导航 |
| 多 Turn 历史 | `conversation_history_page`、snapshot | 补齐客户端归一化和展示 |
| 安全阶段与 Turn 终态 | `trace_delta`、final/error、snapshot | 以结构化状态为准，不解析文案 |
| Task/Subtask/Attempt | `task_projection`、`execution_delta`、历史执行投影 | 补齐身份和详情；不从原始输出猜 |
| 权限 | `permission_request` 与服务端当前权限事实 | 明确 pending/resolved/expired 的公共投影 |
| 产物 | `artifact` 与历史产物事实 | 关联到准确的 Turn/Task |
| 结果 | result 系列事件及 `final_answer` | 复用完整性校验，统一结果身份与去重 |
| 命令输出 | 现有系统命令事实与结果 | 单独呈现，保留后续执行关联 |

必须先列出字段级 fixture，再判断缺口来自 Server 还是 TUI reducer。
当前 `task_projection` 的少量状态字段不能被宣称为完整 Task Dashboard DTO。

### 9.3 受限只读查询扩展

为避免走旧 Planner Host，本设计拟在现有 Gateway command plane 增加两个
确定性只读请求，不新增 transport、第二个 Gateway 或语义路由：

| 拟新增命令 | 请求 | 响应事件 | 行为 |
| --- | --- | --- | --- |
| `complete_command` | scope、text、cursor | `command_completion` | 复用 Server command catalog，返回候选、替换范围与提示 |
| `get_task_view` | Conversation scope、turnId、taskId | `task_view_snapshot` | 通过 Application 查询端口返回该 Turn/Task 的安全展示快照 |

这些命令已在阶段 B 实施（见 §18.3），行为约束如下。
scope 必须经过统一认证与解析；`get_task_view` 必须验证 Account、Conversation、
Turn、Task、Workspace 关联，未知或不匹配时返回结构化错误。
`complete_command` 在 Workspace scope 下只提供该范围合法的导航/只读候选；
Conversation scope 必须显式 attach 已存在的 Conversation。两个查询都不得使用
`new` 或隐式创建绑定来获得上下文，不得为了补全自动创建 Conversation。

只读请求规则：

- 在 Application/Gateway 的只读分支处理，不进入语义 mailbox，不启动 Planner，
  不创建 Turn，不占业务 work reservation，也不阻塞正在运行的 Turn。
- 沿用版本化 command envelope 和 requestId；receipt 与数据响应分离。
- 响应仅发送到请求连接，复用现有 connection-event-stream 身份；
  payload 显式携带目标 Conversation，不能把 stream ID 当 Conversation ID。
- 响应模型区分逻辑目标与运输流：Workspace 补全的 targetConversationId 为 null；
  Conversation 查询必须回显目标 ID、requestId 和查询版本。客户端丢弃已过期的
  导航/输入版本响应；同一连接的只读响应与其他 connection 事件共用序号分配器，
  不得各自从 1 开始，也不得用该序号更新 Conversation 的历史 cursor。
- 补全草稿及候选不写 Conversation 历史，不广播，不写持久 command body/audit 文本。
  为该只读分支设置临时、有限的回执缓存与连接内响应序号；不得复用持久业务
  admission 的输入存储。审计只保留请求类型、结果、时长等安全元数据。
- Task 快照是读投影，不生成重复 durable Task/trace 事实；原业务事件仍正常持久化。
- 补全建议最多 50 项，输入最多 8 KiB，cursor 为输入字符串有效 UTF-16 偏移。
  客户端约 150 ms 去抖、每个编辑器最多一个待应用请求；Server 每连接限制频率。
- Task 初始快照只包含有界摘要和当前/选中 Attempt；长轨迹继续使用已有分页或
  补充受限分页字段，不放宽单事件大小上限。

Server 通过现有 `ConversationSession.completeCommand` 所用的查询能力提供补全；
不能把包含 DB、TaskEngine 的 `CommandContext` 或整个 catalog 实现发给客户端。
UI 只应用 Server 返回的替换区间，不自建 Task 名称解析和命令授权逻辑。

Task DTO 至少包含安全身份、标题、状态、Subtasks、Attempt 摘要、公开路由显示值、
开始/结束时间、进展摘要、权限状态、结果与 artifact 引用、快照水位和分页信息。
它复用当前 ExecutionProjector/历史投影的 owner，不复制一套状态计算。
快照的 `asOfSequence` 必须属于目标 Conversation 的事件流，并在 Application
投影的一致性边界内取得；不能使用响应所在 connection 流的序号代替。
若当前查询端口不能提供与事件流一致的快照水位，阶段 B 必须先补齐这个接口，
不得交由客户端按时间戳猜测快照覆盖了哪些进展。

### 9.4 版本、安全与跨端兼容

新增只读命令和响应采用 Gateway v2 的显式能力扩展：
在 Server hello 的安全元数据中公布 `command_completion_v1`、
`task_view_v1` 等 capability，TUI 校验后使用。
该能力清单已在阶段 B 随 hello 实现。

新 TUI 要求同一发布版 Server 提供必需能力；缺失时明确提示升级，不恢复旧 TUI、
不连接 Planner Host、不静默丢掉完整面板。
Web/Feishu 不必消费新查询，但其既有字段和语义必须保持兼容。
若实施中发现必须破坏 v2 字段语义，应先评审版本升级，不能同号改变解释。

主仓库协议是权威，vendored `gateway-protocol.ts` 是跨隔离构建的镜像。
用字段级契约测试检查两者及 Web/Feishu 消费边界，不能只比较 event kind 名称。
未知可选字段允许忽略；未知必需能力或非法 payload 明确拒绝，不能打印原始数据。

## 10. 展示状态模型与事件算法

### 10.1 唯一只读模型

```text
ClientState
  connection + per-stream watermarks + bounded dedupe windows
  activeWorkspace + Conversation directory
  selectedConversationId + navigationGeneration
  Conversation projections, bounded cache
    ordered Turn IDs + history cursor
    Turn projections
      request identity + authoritative status
      presentationTaskId
      safe trace + Task/Subtask/Attempt projection
      permissions + result references + artifacts
    system command projections
  UI state
    draft by Conversation + selectedTurnId
    scroll anchor + expanded panels + focus + theme
  pending submissions
    immutable envelope + receipt state + uncertainty state
```

结构只是客户端读模型，不是 Task 或 Conversation 的第二份持久真相。
`sending`、`reconnecting`、`cancelling-requested` 等属于 UI 状态，不能写入业务 status。
Turn 的 `running/completed/failed/blocked/cancelled` 必须来自 Server；
传输失败不能把服务端运行中的 Turn 标记为业务失败。

### 10.2 统一处理流程

```text
Gateway frame
  -> envelope / payload / size validation
  -> stream and target identity check
  -> deduplication and snapshot watermark handling
  -> pure reducer
  -> view model selectors
  -> Pi components
```

live、历史分页、replay 和只读 Task 快照进入同一归一化/reducer 管道，
不允许一个路径 append 字符串、另一个路径更新模型。

必须保持的不变量：

1. stream 序号按实际流隔离；Workspace、connection 与 Conversation 流不能比较一个全局序号。
2. 同一 eventId 幂等；eventKey 用于具体领域进展去重，不吞掉不同 Attempt 的同名事件。
3. 详细 live 采用 origin 过滤，因此序号有间隔不自动表示丢包，不按 `last + 1` 无限重连。
4. 旧 Task/历史 Turn 事件只能更新对应记录，不能重开已结束 Turn 或覆盖当前选中项。
5. terminal 状态单调；迟到的结果可以丰富内容，但不能将终态改回 running。
6. Task 快照水位之前的缓冲事件不重复应用；水位之后的合法事件继续应用。
7. result stream、snapshot、final answer 按服务端关联去重，不能仅比较 Markdown 文本。
8. hash/字节校验失败表示结果传输问题，不是 Kernel 认证失败，更不是 Task 自动重试理由。
9. 时间、requestId 和 canonical ID 负责关联；不得用标题、自然语言或数组位置猜身份。

### 10.3 有界历史与渲染

历史默认每页请求 50 条，并受 Server 上限约束。内存缓存按页和字节预算淘汰，
保留当前活动 Turn、待确认请求、可见页及滚动锚点；淘汰后可以重新请求历史。
eventId 去重集合与结果块缓存均必须有界，不能随着整天运行无限增长。

只渲染视口与有限邻接区域；普通进展可合并到约 30 fps 内，
权限、错误、终态立即安排重绘。合并绘制不能丢事实或修改业务事件顺序。
长结果不整段重复 append，未完成结果块不得为了腾空间而静默截断成“完整结果”。

## 11. 跨端一致性、导航和恢复

### 11.1 同一事实不等于实时广播

严格保留 [ADR-0036](../adr/0036-origin-scoped-live-delivery-and-replay.md)：

- 详细 live 事件只发给发起该 Turn 的连接。
- 授权的 attach/history/replay 可读取同一 Conversation 中各端产生的历史。
- Workspace 活动状态是可共享摘要，不能夹带其他端的详细结果或权限操作。
- 无法恢复 origin 的后台事实仅进入历史，不广播给全部客户端。
- TUI Task 面板不以周期性全账户查询绕过 origin 限制。

因此 Web 发起任务不会无故抢占 TUI 的当前 Turn；
用户主动刷新、切换或重连后可以看到该任务的授权历史。

### 11.2 导航与输入目标

导航使用客户端递增 generation，串行化本连接的 Workspace/Conversation attach，
不串行化账户业务执行。过时响应不能覆盖新选择。

切换后旧请求的回执仍归属原 scope；允许保存进程内草稿，但绝不把 A 会话输入
自动发送到 B。Server 确认新 Workspace/Conversation 前，UI 标识为切换中。
显式 attach 保留持久 Workspace，cwd 只是未选择时的 hint。

### 11.3 重连和不确定提交

连接状态为 `connecting -> ready -> reconnecting -> ready`，另有
`incompatible/draining/closed`，与 Task 状态分离。

恢复遵守 subscribe/buffer、replay、watermark、release newer live 的顺序。
过期 cursor 使用 Server reset snapshot；必要时再加载历史页，不要求 journal
无限保留每个中间 token。

如果发送后断线且没有 receipt：

- 保存同一个不可变 envelope，标为“受理状态待确认”。
- 同一客户端进程恢复后只可重放相同 requestId/idempotencyKey、目标和内容。
- 不通过现有 `submitUserInput()` 再生成一组 ID；需完善 GatewayClient 的提交 API。
- 不自动创建另一条消息；无法判定时引导刷新历史并显式处理，不谎称“发送失败”。
- 客户端进程退出后不承诺自动恢复未确认草稿；没有本地持久命令队列。

权限与取消的旧请求重放仍由 Server 检查当前有效性。
断线、退出或终端崩溃不触发 Task 取消、Planner abort 或 Server shutdown。

## 12. 安全与本地副作用

- Gateway 认证及 Account/Conversation/Workspace 授权在 Server 执行，
  TUI 菜单是否显示不构成权限控制。
- 只读补全也不得泄露其他 Conversation 的 Task、配置 secret 或未授权路径。
- UI 不展示 hidden reasoning、raw prompt、原始工具参数、stdout/stderr、
  credential、内部 binding fingerprint 或未经筛选的 model message。
- 所有正文、标题、文件名和错误都视为不可信显示内容。终端控制字符、
  OSC/ANSI escape 等不得来自远端原文直接执行；样式仅由可信组件生成。
- 不自动打开服务端给出的任意 URL，不自动写剪贴板，不读取 artifact 路径。
  第一版只展示授权的产物元信息及明确的不可预览提示。
- 不读取用户 `~/.pi`、`~/.codex` 或 Workspace 的扩展、工具和模型配置。
- 允许主题与键位设置保存到 MetaWork 管理的客户端偏好位置，
  独立于 Planner home、SecretStore 和 Configuration Control Plane。
- endpoint、socket 和发布版身份验证继续复用现有安装与启动器机制。

## 13. 删除清单与保留清单

### 13.1 最终必须删除或合并

| 对象 | 处理 |
| --- | --- |
| 简版 `anyfusion-client-mode.ts` 的旧 TerminalClientView | 被唯一新组件树替代后删除 |
| 简版 `metawork-client-view.ts` 等旧展示层 | 规则迁移到新 reducer/model；删除重复 renderer |
| 旧 `InteractiveMode` | 组件提取后删除本地 Agent 交互控制器、入口和无用导出 |
| 旧 Planner Host 驱动的 Dashboard/权限/补全 UI glue | 替换为 Gateway 客户端，不保留客户端 Host 连接 |
| `src/tui/` | 按行为测试迁移结果删除 |
| `src/gateway/client-ui.tsx` | 删除旧 Ink Gateway UI |
| `src/gateway/readline-client.ts` | 若完整引用审计确认仅服务被删旧 UI，则一并删除 |
| Ink 专用依赖、测试库、脚本、旧环境变量说明 | 引用清零后清理；同步 lockfile 与构建 |
| simple/full/standby 开关及恢复指令 | 不在产品中保留 |

旧源码只存在 Git 历史，不复制到新 `legacy-tui/` 目录继续编译。
仍被非交互运行路径使用的纯 helper 必须先迁往正确 owner，再删除原控制器。

### 13.2 明确保留

- `pi-tui` 基础库、被复用的主题与展示组件、上游 attribution。
- `GatewayClient`、socket transport、统一协议及服务端 Gateway。
- 受控 Planner RPC、`AgentSessionRuntime` 在服务端 RPC 所需的实现、
  Pi 会话持久化、固定 Skill、proposal tool、MCP 与 Planner Host。
- canonical Executor CLI 的执行、权限与 attempt 配置。
- Web 与其他消费者仍需要的 React 和类型依赖。

不能因为目录名含 `tui-bridge` 就删除 [PlannerHostBridge](../../src/tui-bridge/planner-host-bridge.ts)。
它仍是受控服务端 Planner 提案链的一部分；本次只切断交互客户端对它的依赖。

### 13.3 Ink 测试处理

逐项分类并记录替代测试：

1. 纯编辑、布局、焦点测试迁到唯一 Pi TUI。
2. 当前仍有效的权限、恢复、任务边界、结果交付断言迁到 Gateway/Application owner。
3. 仅验证旧客户端直接决定 Task 状态的过时断言删除，不把错误策略迁入新客户端。
4. 保留命令与领域层已有有效覆盖；不因删 UI 就批量删除核心回归。

删除 Ink 不自动授权删除整个 `MetaclawSession` 或其他兼容/测试 shell；
这些对象若仍有非 TUI 消费者，本次不扩大清理范围。

## 14. 迁移阶段与退出条件

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| A：设计与契约基线 | 评审本设计、ADR、Pi 组件清单、三端 fixtures、删除依赖图 | 明确 owner、必需字段、保留测试及切换门槛 |
| B：Gateway 缺口 | 历史客户端 API、补全与 Task 只读命令、权限生命周期、版本能力 | 不启动 Planner 的查询测试通过，Web/Feishu 不退化 |
| C：组件解耦 | 提取编辑器、主题、对话、Task 面板，建立纯安全 DTO | 新组件不依赖本地 Agent/Host/工具实现 |
| D：唯一客户端整合 | 多 Turn reducer、导航、回执、重连、取消、权限与完整布局 | 所有 fixture、终端和边界测试通过 |
| E：硬切换及清理 | 同一发布版本切换入口，删除简版/旧 InteractiveMode/Ink | 产品只有一套 TUI，无残留运行开关 |
| F：发布验收 | native、Docker、真实 Planner、三端回归与文档闭环 | 全部门槛满足，记录证据与 closing commit |

开发期间新组件可在测试 harness 中并行建设，但不发布第二个用户入口。
不存在长期“双 UI 兼容期”；切换前旧入口不动，切换发布时一次收敛。

回滚依赖现有受控整版 release rollback，不通过环境变量恢复删掉的 UI。
若扩展事实超出现有存储能力而需要持久化变更，必须补充 schema、repository、
迁移和 Docker 测试后再继续；本文不预先宣称“无需任何存储变更”。

## 15. 测试与验收矩阵

### 15.1 架构和协议

- 扫描新客户端入口的传递依赖，不只检查几个文件的 import 字符串。
- 启动客户端时断言未创建模型 client、AgentSessionRuntime、SessionManager、
  Planner Host、SQLite 或 Workspace 工具。
- 无 Gateway 的 vendored 交互调用明确失败，RPC 路径仍可用。
- 补全/Task 查询经过相同授权且不创建 Turn、Kernel event 或业务 reservation。
- 主仓库、vendored Pi、Web、Feishu 对同一 fixture 的身份和状态解释一致。
- 不兼容 Server、非法 payload、超限结果、过期权限均 fail closed。

### 15.2 reducer 与交互

| 场景 | 必须断言 |
| --- | --- |
| live/replay/history 顺序与重复 | 最终展示事实一致，消息与结果不重复 |
| 外端 origin 造成序号间隔 | 不误报丢事件、不无限 resync |
| 多 stream 交错 | Workspace/connection 序号不推进 Conversation cursor |
| snapshot 与正在到达的 live | 水位前不重复，水位后不丢失 |
| 两个 Turn 与多个并行 Subtask | 精确归属，历史选择不被抢占 |
| 系统命令返回后执行继续 | 命令完成与 Task 完成分离 |
| 完成/阻塞/取消后迟到事件 | 不重开 Turn、不错误显示运行中 |
| result 分块重复、缺块、hash 不符 | 不复制正文、不伪造完整或认证 |
| 草稿编辑中收到旧补全 | 不覆盖新文本，不串 Conversation |
| 断线丢 receipt 后重放 | 相同 envelope，服务端只受理一次 |
| 权限回放、过期、跨端已处理 | 不能批准旧请求，输入字母无业务副作用 |
| Planner 阶段取消与执行阶段取消 | 同一 cancel_turn 语义；取消后 Conversation 仍可用 |
| 缩放、中文、长路径、粘贴与焦点 | 草稿不丢失、操作可达、无意外命令 |
| 控制字符与隐藏字段样本 | 不执行远端终端控制序列，不泄露敏感信息 |

### 15.3 三端与真实运行

1. 一个 Server 同时连接 Web、TUI 和已配置的飞书适配器。
2. 各端提交都走统一 Gateway；客户端退出不影响已受理工作。
3. 各端只收到自己发起 Turn 的详细实时输出；主动历史读取可见其他端已授权事实。
4. TUI 创建/切换 Conversation 不修改历史 Workspace，不影响其他端选择。
5. Web 的 Conversation、Trajectory、附件、结果、Settings、登录和主题行为不退化。
6. 飞书的卡片、分片、限流、交付重试、权限与会话绑定行为不退化。
7. 真实 Planner 两轮语义连续性、Executor artifact 交付和取消后继续对话通过。
8. 80x24、120x36、160x48 native 终端实际截图/录屏及交互记录通过。
9. 长时间事件流与大历史验证内存有界、输入不饥饿、结果完整。
10. Docker 构建验证两个源码树、Unix bridge、RPC 和核心回归未被清理误伤。

### 15.4 验证入口

实施时至少运行以下已有入口，并按新增测试落点补充聚焦用例：

```bash
npm run lint
npm test -- tests/client tests/architecture tests/gateway
npm run build
npm run smoke:clients
npm run smoke:gateway
npm --prefix planner/AnyFusion-Pi run build:offline
npm --prefix planner/AnyFusion-Pi/packages/coding-agent test
npm run smoke:metawork
npm run smoke:metawork -- --scenario artifact
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

真实模型、飞书和 Docker 验证依赖安装与外部环境；未执行的项必须标注未验证，
不能用 mock、静态 import 测试或“界面可启动”代替。
不要用带 `--write` 的仓库全量检查命令制造无关格式变化。

## 16. ADR、文档与实施门

本设计不直接把现有代码描述成已改造，也不静默推翻当前 Ink 保留规范。
实施前新增一个单 TUI 收敛 ADR，编号以届时 ADR 索引为准，明确：

- 保留 ADR-0020 的 owner 和依赖方向。
- 保留 ADR-0031/0034 的统一 Gateway 与独立 Client。
- 保留 ADR-0035/0036/0037 的 Workspace、origin、并发语义。
- 保留 ADR-0032/0040 的结果与取消契约。
- 替代旧计划中“不删除 Ink”的范围决定，明确唯一客户端与旧入口退役。
- 固定只读 Gateway 扩展、公共投影与客户端禁止依赖。

实施同时更新 `CONTEXT.md`、中英文 technical overview、
`docs/current/account-runtime-and-gateway-operations.md`、ADR 索引、`docs/README.md`。
`AGENTS.md` 更新旧 TUI 入口导航和 Ink 保留规则，不扩写业务策略。
对仍被当作当前说明的旧 standby 启用指令进行纠正，历史交付记录保持历史身份。

后续实施计划必须列明每个 seam 的文件、失败测试、实现、验证和删除条件。
不得在“恢复完整 TUI”的名义下顺便改写 Planner、业务恢复策略或 Web 产品设计。

## 17. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 旧完整控制器太大，提取时带入 Agent 功能 | 按组件提取、窄 DTO、传递依赖测试；不做远程 Session 仿真 |
| Gateway 字段不够，客户端开始猜业务状态 | 字段级 fixtures；缺口在 Application projection 补齐 |
| 新只读查询把输入草稿写入业务历史 | 单独只读受理分支、临时回执、敏感审计测试 |
| 只改界面而沿用单 currentTurn 模型 | 多 Turn/Task 身份先于界面切换完成 |
| 原始模型/工具组件泄露隐藏内容 | 安全 DTO 白名单，禁用原始消息与工具 renderer |
| 删除 Ink 一并丢失有价值的回归 | 测试逐项归类，替代测试先落地 |
| 删除 vendored 交互代码损坏 RPC 构建 | 入口图审计、offline build、真实 Planner 连续性 smoke |
| 完整面板导致渲染与内存退化 | 视口渲染、有界缓存、长流压测和终端输入延迟观测 |
| 用户误以为所有 Pi 功能都恢复 | 以第 3、7、8 节为功能合同，不显示未实现菜单 |

## 18. 评审与交付记录

### 18.1 已确认的产品方向

- Web、Feishu、TUI 都通过 Gateway 操作 Server 的同一业务系统。
- 各端只在展示和交互上不同，不各自持有业务 Runtime。
- TUI 采用完整 Pi 交互体验，替代简版；最终删除多余 TUI。
- 本轮仅交付详细设计文档，不改运行代码。

### 18.2 本文提出、仍需随详细设计批准的取舍

- “完整”的第一版范围以本文能力清单为准，不包含本地 Agent、扩展、文件上传与预览。
- 新增两个受限只读 Gateway 请求及显式能力声明，不恢复 Planner Host UI 通道。
- 提取组件后删除旧 InteractiveMode，保留服务端 RPC 所需共享实现。
- 新 TUI 上线采用同版 Server 硬切换，不保留旧 UI 开关。

### 18.3 文档与实施状态

- Design artifact date: 2026-09-19。
- Delivered artifact: 本详细设计及文档索引；不表示功能已交付。
- Code inspection: CLI/启动器、Pi 两套界面、Gateway 命令和事件、Ink 引用、
  当前 ADR、构建入口与现有测试结构。
- Document validation: 新设计的 30 个本地链接均有效，索引新增链接有效，
  `git diff --check` 通过。索引既有 4 处失效链接已与 HEAD 基线核对，
  不由本次引入，未进行无关修复。
- Baseline tests: `no-client-runtime-ownership`、`current-client-runtime-topology`、
  `tui-client-launcher` 三个测试文件共 12 项通过；仅证明当前基线，
  不代表本文拟议的完整界面和协议扩展已实现。
- Phase B implementation date: 2026-09-19。
- Phase B delivered behavior:
  - `src/gateway/client-protocol.ts`：`complete_command`（8 KiB 输入上限、
    UTF-16 cursor 校验、Workspace scope 或显式 attach 的 Conversation scope）与
    `get_task_view`（Conversation/Turn/Task 关联参数）命令及 scope 规则；
    `command_completion_v1` / `task_view_v1` 能力常量与 `GATEWAY_SERVER_CAPABILITIES`。
  - `src/gateway/client-events.ts`：`command_completion` / `task_view_snapshot`
    事件 kind（非 origin-scoped，按 connection 流定向）。
  - `src/gateway/protocol.ts` / `server.ts`：hello 显式公布能力清单。
  - `src/gateway/client-gateway.ts`：只读查询分支——认证与授权后绕过持久
    CommandAdmissionStore（草稿不持久化），临时有界回执缓存（256 条 FIFO）、
    idempotency 冲突检测、每连接限频（10 次/秒）；handler 缺失时 fail closed。
  - `src/gateway/read-only-query-handler.ts`（新增）：响应仅发布到请求连接的
    connection 事件流；payload 显式携带 `targetConversationId`；候选上限 50；
    不写 Conversation 历史、不经 journal.append 持久化。
  - `src/gateway/event-journal.ts` / `file-event-journal.ts`：新增
    `reserveSequence` / `lastSequence`；临时响应与持久 connection 事件共用
    序号分配器，append 不会复用已保留序号（高水位随 lastSequence 持久）。
  - `src/gateway/task-view.ts`（新增）：Task View 安全 DTO（schemaVersion 区别于
    旧 Planner Host snapshot；复用 ExecutionProjector 的 timeline 类型）。
  - `src/server/server-composition.ts`：ExecutionProjector / TaskArtifactRepo
    提升为 Gateway 与 Web 共享的单一投影 owner；`completeCommand` 经已打开
    Conversation 的 `ConversationSession.completeCommand`（未打开时返回 inactive，
    不启动 Planner）；Workspace scope 使用静态导航白名单补全；`getTaskView`
    验证 Conversation/Turn/Task 关联，结果元数据与 `asOfSequence` 取自目标
    Conversation 事件流。
  - vendored `gateway-protocol.ts` 镜像同步；`GatewayClient` 新增
    `getConversationHistory` / `completeCommand` / `getTaskView` /
    `serverCapabilities` / `hasServerCapability` / `submitWithEnvelope` /
    `resubmitEnvelope`（断线重放复用同一 envelope，不生成新 ID）；
    socket transport 捕获 hello 能力。
- Phase B validation:
  - `npm run lint`（tsc --noEmit）通过。
  - `npm test -- tests/client tests/architecture tests/gateway`：50 个文件 299 项
    全部通过，含新增 `read-only-query-handler`（9 项）、`gateway-protocol-mirror`
    （3 项）与扩展的 `client-protocol` / `client-gateway` 用例；只读查询不触及
    mailbox / activateAccount / 持久 admission 的断言生效。
  - `npm --prefix planner/AnyFusion-Pi run build:offline` 通过；vendored
    `anyfusion-gateway-client` 测试 14 项通过。
  - 未执行：native 终端验收、真实 Planner smoke、Docker 构建（阶段 F 门槛）。
- Phase C/D implementation date: 2026-09-19。
- Phase C/D delivered behavior:
  - 唯一组件树：`modes/metawork-tui/` 新增 `layout.ts`（80x24/120x36/160x48 响应式
    布局与时长/静默格式化）、`components/editor.ts`（MetaWorkEditor：Enter 提交、
    `\`+Enter 换行、F1/F4/F5/F6/F7/F8/F9 客户端键位、Ctrl+C/Ctrl+D 只退客户端）、
    `components/conversation-panel.ts`（多 Turn：用户请求/过程摘要/结果各一位置，
    历史缺失提示，结果 streaming/failed 不伪装完整）、`components/task-dashboard-panel.ts`
    （选中 Turn 的 Task → Subtask → Attempt 投影、服务端时间与静默区分）、
    `components/status-bar.ts`（头部/操作行，能力缺失提示升级）、
    `components/permission-panel.ts`（仅聚焦后 a/x 生效，标记已处理/过期后禁用）、
    `components/help-panel.ts`（只列实际可识别绑定）、`components/root.ts`（正文并列
    渲染与列宽钳制）。
  - 会话选择器按 Git 可追溯方式迁移到 `components/conversation-selector.ts`，
    改用新模型类型；旧 client mode 暂时引用新路径（阶段 E 删除）。
  - Controller（`controller.ts`）：显式操作→版本化命令；提交前先固定不可变
    envelope，丢 receipt 标为“受理状态待确认”并只重放同一 requestId；`/cancel`
    仅展示“正在请求取消”直到权威 Turn 状态；权限只发 requestId+approve/deny，
    过期/已处理/未知请求拒绝；补全按版本与 scope 匹配、旧响应丢弃；导航代际与
    `attachConversation` 归属校验；断线后 `recover()` 重放不确定提交再 replay。
  - 补全桥接（`completion-provider.ts`）：pi-tui AutocompleteProvider ↔ Gateway
    只读补全，只应用 Server 返回的替换区间，scope 不匹配返回 null。
  - 客户端偏好（`preferences.ts`）：只白名单 `theme`，写入 MetaWork 配置目录，
    不读 `~/.pi`；读取/写入失败降级不崩溃。
  - 应用装配（`app.ts`）+ 入口（`index.ts`）：唯一组件树、编辑器动作绑定、
    帮助/权限/Task 弹层与焦点，compact 布局用非捕获 Task 覆盖层。
  - `main.ts` 的 `--gateway-socket` 分支改为延迟 `await import("./modes/metawork-tui/index.ts")`，
    不再静态导入旧 client mode；`metawork` / `metawork tui` 现在只进入唯一新 TUI。
  - GatewayClient 新增 `buildEnvelope` / `submitEnvelope` 公开 API，支撑发送前固定
    envelope 与断线重放同一 ID。
  - 架构测试扩展：主仓库 `no-client-runtime-ownership` 扫描新 TUI 树（禁止
    AgentSession/SessionManager/ToolDefinition/PlannerHost/storage/kernel/executor
    等依赖）并断言入口为延迟导入。
- Phase C/D validation:
  - vendored 新增 `metawork-tui-reducer`（13）、`metawork-tui-render`（16）、
    `metawork-tui-controller`（13）、`metawork-tui-completion-and-preferences`（8）、
    `metawork-tui-app`（6，含假终端渲染冒烟），加上既有 `anyfusion-gateway-client`
    （16）、`metawork-conversation-selector` 与 `anyfusion-client-mode` 共 83 项通过。
  - `npm run lint`、主仓库 `tests/client tests/architecture tests/gateway tests/web tests/scripts`
    通过（唯一失败为基线已存在的 `tests/web/workspace-shell.test.ts`）。
  - `npm --prefix planner/AnyFusion-Pi run build:offline` 通过。
  - 修复发现的真实缺陷：权限面板未校验焦点即可响应 a/x（已修为仅焦点内有效）。
  - 连接失败路径：`--gateway-socket` 指向不可用 Server 时在界面内显示
    “无法连接 Server … 请先运行 metawork server start”并保持 `closed`，
    不启动本地 Agent、不打印堆栈、不因随后的 disconnect 误报“已连接”
    （已用构建产物实测）。
  - 未执行：真实 native 终端交互与截图验收、真实 Planner/Docker（阶段 F）。
- Phase E implementation date: 2026-09-19。
- Phase E delivered behavior:
  - 主仓库删除 Ink 面：`src/tui/`、`src/gateway/client-ui.tsx`、
    `src/gateway/readline-client.ts` 及其测试；移除 `ink`、
    `ink-testing-library` 依赖与 lockfile 条目；`native-launcher.ts` 不再
    `unset METACLAW_STANDBY_TUI`；架构测试改为断言旧面不存在。
  - vendored 删除简版/本地交互面：`anyfusion-client-mode.ts`、
    `metawork-client-{model,reducer,view}.ts`、`interactive-mode.ts`、
    仅其使用的 31 个组件，以及 30 个专用测试；`modes/index.ts`、`src/index.ts`
    同步收敛导出。保留仍被 core tools/CLI/新 TUI/RPC 使用的组件
    （keybinding-hints、diff、visual-truncate、config-selector、
    extension-*、first-time-setup、session-selector、dynamic-border、theme）。
  - 无 Gateway 的交互调用明确失败：`main.ts` 在解析出 interactive 模式时打印
    “the standalone interactive agent UI is retired in this build. Use
    `metawork tui`…” 并以 exitCode 1 退出，不隐式启动本地 Agent；`--mode rpc`
    与 print/json 模式保持可用（已用构建产物验证模块加载）。
  - 测试迁移（§13.3 规则 2/4）：`tests/tui/task-list.test.ts` 移入
    `tests/commands/`（无 Ink 依赖的领域测试）；新增
    `tests/session/resume-persisted-execution-context.test.ts` 承接
    “恢复/解除阻塞时传入持久化任务级执行上下文且不注入未声明资源”两项领域断言；
    其余 Ink 测试的断言逐项映射到既有 owner 覆盖（risk gate →
    `tests/session/scripted-session`，网络失败 retry wait →
    `tests/execution/kernel-execution-runtime-recovery`，blocked/permission 旅程 →
    `tests/session/blocked-task-user-journey`，任务边界 →
    `tests/session/task-boundary-round3-acceptance`，编辑器行为 → pi-tui
    `editor.test.ts` 与新增 TUI 组件测试）。
  - 修正基线缺陷：`tests/web/workspace-shell.test.ts` 对 Agent 就绪横幅的过期文案断言
    更新为当前文案；`scripts/smoke-unified-gateway.mjs` 的 native TUI 验收改为
    断言唯一 TUI 顶部栏（MetaWork/已连接/Workspace basename），按进程组清理三层
    子进程，restart 验收接受 detached 重启的就绪标记并按 manifest PID 兜底清理。
- Phase E/F validation:
  - `npm run lint`、`npm run build` 通过。
  - 主仓库 `tests/client tests/architecture tests/gateway tests/web tests/scripts`
    全绿（含更新后的 workspace-shell 与 native-tui-gateway 断言）。
  - vendored `npm run build:offline` 通过；新增 TUI 测试 56 项与
    `anyfusion-gateway-client` 等共 83 项通过。
  - `npm run smoke:clients` 通过；`npm run smoke:gateway` 端到端通过
    （root acceptance + Planner TUI acceptance + 隔离 root 安装 + 唯一 TUI 顶部栏
    断言 + 多客户端并发 + restart + workspace 恢复），退出后无遗留进程。
  - 真实终端验收（macOS PTY，`/usr/bin/script` 分配伪终端，最小 Gateway
    double 提供 hello/能力/事件）：80x24 compact（对话优先 + Task 覆盖层）、
    120x36 与 160x48 header + 并列 Task Dashboard 均渲染正确；验证 F4 权限面板
    overlay（`a 允许 · x 拒绝 · Esc 关闭`）、F7/F8 Turn 选择、补全草稿、
    结果 Markdown 与 `[结果 已认证]`。捕获文件位于 /tmp（未入库）。
  - 发现并修复的真实缺陷：新 reducer 只识别 `workspace.path`，而服务端
    `WorkspaceRecord` 使用 `canonicalPath`，导致顶部栏永远显示 Workspace
    “未设置”（已修复并加回归测试）。
  - 未验证（依赖外部环境）：真实 Planner 双轮语义与 artifact 交付
    （`npm run smoke:metawork`）需要已安装 Executor 与 Provider 凭据，本机未配置；
    飞书真实投递同样未执行；Docker 见下条。
- Docker validation: 未完成（环境限制）。`docker build -f Dockerfile.test -t
  metaclaw-test .` 在本机无法拉取基础镜像（`auth.docker.io` 超时），因此
  `docker run --rm metaclaw-test` 未执行。同一批 SQLite/POSIX 路径测试已在
  macOS 主机上原生执行（`tests/session`、`tests/commands`、`tests/gateway` 等
  均使用 better-sqlite3 并通过），但 Docker 双源码树/Unix bridge 验证仍未完成，
  发布前必须在可用网络环境补做。
- Implementation completion date: 阶段 B/C/D/E 完成于 2026-09-19。
- Runtime/terminal acceptance: 已完成 macOS PTY 三尺寸交互验收（见上）；
  未录制真实终端视频/截图文件（证据为终端捕获文本）。
- Closing commit: 全部变更未提交（按用户要求不提交）。

## 19. 相关当前权威

2026-09-20 代码审查发现原验收遗漏真实 Socket 响应解析、补全时序、导航和
Task 查询接线等问题。修复范围、回归测试及尚未覆盖的外部环境验收见
[TUI review fixes](2026-09-20-tui-review-fixes.md)。原 §18.3 的验收记录
是当时执行结果，不替代本次修复后的验证。

- [ADR-0020：模块所有权](../adr/0020-core-module-ownership-and-dependency-direction.md)
- [ADR-0031：Account Runtime 与 Gateway](../adr/0031-account-runtime-and-unified-client-gateway.md)
- [ADR-0032：结果优先交付](../adr/0032-result-first-delivery-and-completion-certification.md)
- [ADR-0034：独立 Server/Client](../adr/0034-independent-server-and-client-process-lifecycle.md)
- [ADR-0035：Workspace Conversation 组织](../adr/0035-workspace-scoped-conversation-organization.md)
- [ADR-0036：origin 实时与历史回放](../adr/0036-origin-scoped-live-delivery-and-replay.md)
- [ADR-0037：多 Conversation 并行](../adr/0037-multi-conversation-task-parallelism.md)
- [ADR-0040：用户取消 Turn](../adr/0040-user-initiated-turn-cancellation.md)
- [2026-08-26 独立 Server/Client 设计](2026-08-26-independent-server-client-and-tui-experience-design.md)
- [2026-08-28 TUI 系统命令与 AI Task 分离](2026-08-28-pi-tui-system-command-separation-design.md)
