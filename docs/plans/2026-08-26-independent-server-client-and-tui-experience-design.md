# MetaWork 独立 Server/Client 与 TUI 体验改造设计

> Status: Approved for implementation
> Design date: 2026-08-26
> Review completed: 2026-08-26
> Review owner: Product / Architecture
> Governing decisions: ADR-0020, ADR-0031, ADR-0032, ADR-0033
> Required decision update: 新增 ADR-0034，修订 ADR-0031 的进程拓扑实施结论

## 1. 目标

本设计同时解决两个问题：

1. Server Runtime 必须可以独立启动并常驻；只有显式
   `metawork server stop`、`restart` 或操作系统服务停止才结束它。TUI 和 Web
   Client 可以分别启动、重连和退出，并连接同一个 Server。
2. 原生 TUI 必须从“原始技术日志查看器”升级为面向用户的任务交互界面，在不
   暴露隐藏思维链的前提下，清楚展示理解、规划、授权、执行、验证和交付过程。
3. Server 启动时不绑定用户 Workspace。每个 Conversation 必须通过统一的
   `/workspace <path>` Gateway command 建立工作区上下文，没有 Workspace 时
   不能执行任务。

最终用户模型是：

```text
先启动一个 MetaWork Server
  -> Server 持续拥有 AccountRuntime、恢复、Kernel 和 Executor
  -> Server 在飞书配置有效时自动连接飞书机器人
  -> 任意时刻启动或关闭 TUI / Web Client
  -> Client 通过 /workspace <path> 选择 Conversation 工作区
  -> Client 通过 Gateway 观察和操作同一份 Conversation / Task 状态
  -> 最后一个 Client 退出时，Server 仍继续运行
```

## 2. 非目标

- 不拆分 Kernel、Planner Host、Executor 为网络微服务。
- 不引入第二个 Runtime、第二个调度器或 Client 侧恢复策略。
- 不允许 Client 直接访问 SQLite、Repository、Planner、Kernel 或 Executor。
- 不恢复或删除 `src/tui/` 下保留的 Ink standby TUI。
- 不通过输出模型隐藏推理、raw prompt、raw stdout/stderr 或凭证来模拟“思考过程”。
- 不提供 Script 形式 Client。
- 不把 TUI 的具体布局变成 Server 协议；Server 只返回安全、完整、可重放的事实，
  TUI、Web 和飞书分别决定自己的展示方式。
- 不重做、简化或迁移当前 Web Client 的信息架构、交互流程、视觉设计和展示内容。
  本次 Web 改动只允许改变连接拓扑，并加入 Workspace 缺失时的必要状态处理。
- 本文档不实施生产代码；设计已完成 review，等待实施指令。

## 3. 当前状态与问题证据

### 3.1 生命周期仍然耦合

ADR-0031 已规定 Client 断开不能停止 `AccountRuntime`，但当前组合根仍把默认
TUI 当作 Server 的前台 surface：

```text
src/index.ts
  -> 构造 RuntimeRegistry / AccountRuntime / Gateway
  -> 启动 Gateway socket
  -> spawn AnyFusion-Pi TUI，stdio: inherit
  -> await TUI child exit
  -> finally shutdown 整个 Server
```

具体表现：

- `src/index.ts` 先执行 `gatewayServer.start()`，随后
  `plannerSupervisor.startInteractive()`。
- `startInteractive()` 返回即进入 `finally { await shutdown(); }`。
- `metawork web` 在同一个进程内构造 Runtime 和 Management Server，因此是
  Server 的一种前台模式，不是独立 Web Client。
- `metawork --connect` 是当前唯一真正的 client-only 路径。
- `ServerApplication` 的类型仍把 `interactive`、`web`、`scripted` 和
  `standby` 定义成 Server surface。

因此，当前实现满足“所有 surface 经过统一 Gateway”，但没有完成“所有 Client
拥有独立进程生命周期”。

### 3.2 启动语义不清楚

当前命令把产品概念混在一起：

```text
metawork                 # 同时启动 Server 和 TUI
metawork web             # 同时启动 Server 和 Web
metawork gateway run     # 仅启动 Server
metawork --connect       # 仅启动 TUI Client
```

用户无法仅从命令判断：

- 当前是否已经存在 Server；
- 新命令会连接旧 Server，还是尝试构造第二个 Runtime；
- 关闭当前终端是否会中断后台 Task；
- Web 与 TUI 是否连接同一个 AccountRuntime；
- 当前 Conversation 使用哪个工作区和配置 revision。

### 3.3 真实 TUI dogfood 结果

2026-08-26 使用当前主干运行了一个真实只读任务：

```text
请分析当前仓库的 README.md 和 package.json，不修改任何文件，
给出一份简短的项目定位、核心能力和三项主要工程风险评估。
```

观察到：

- 首屏标题仍显示 `ANYFUSION`，产品身份错误。
- socket 路径、Conversation ID 和版本占据标题区主要位置。
- “执行轨迹”和“对话”是两个不断增长的文本块，没有按一次用户请求组织。
- 用户输入同时以 `You:` 和 `>` 两种形式出现。
- `task_projection` 直接展示 `planner running`、`runtime updated` 等内部状态，
  缺少用户可理解的阶段。
- Planner、Kernel 授权、Executor、验证和交付没有稳定视觉层级。
- Executor 长时间执行时只显示 session started 或技术心跳；没有当前动作、已耗时、
  最后有效进展和“仍正常运行”的明确表达。
- 轨迹全量展开并持续向下推，最终结果容易被淹没。
- 编辑器在任务执行期间仍像空闲状态，缺少 busy、取消和权限等待状态。
- 结果流虽有 hash/长度校验，但最终答案没有独立、突出的结果容器。
- 最终答案在 Executor result、Conversation snapshot 和 result stream 之间被重复
  渲染，同一份 Markdown 在屏幕中出现多次。
- 完整 Task/Subtask ID 被拼进最终结果标题并强制换行，显著破坏正文可读性。
- terminal 后继续重复输出相同 `task_projection`，包括空数组和 `null` 字段。
- 本次 Turn 完成后自动插入与当前请求无关的历史阻塞任务队列，挤占结果区并造成
  “这些任务是否属于本次执行”的认知混乱。
- 重放事件直接 append 文本，缺少可证明幂等的 presentation state。

结论：主要问题不是颜色或边框，而是信息架构和状态模型错误。

## 4. 设计原则

### 4.1 Server 是唯一 Runtime 所有者

Server 进程拥有且仅拥有：

- `RuntimeRegistry` / `AccountRuntime`；
- `ConversationRegistry` 和 Conversation mailbox；
- Planner Host 与语义 Planner RPC；
- ControlKernel、Kernel workflow、恢复和定时器；
- Task、Work Graph、Execution、资源与权限；
- SQLite、event journal、result、artifact 和配置 activation；
- Gateway 的认证、Account/Conversation/Workspace 解析和传输端点；
- 飞书机器人 transport adapter；配置有效时自动连接并维持重连。

### 4.2 Client 只有交互与展示责任

TUI、Web、飞书交互面和未来 App 可以：

- 认证并连接 Server；
- 创建、选择或附着 Conversation；
- 通过 `/workspace <path>` 设置当前 Conversation 的 Workspace；
- 提交版本化 Gateway command；
- 保存自己的 replay cursor；
- 把 Gateway events 投影为界面；
- 提交取消和权限决定。

Client 不可以：

- 构造 Runtime 或访问 storage；
- 直接启动语义 Planner；
- 调用 Kernel、调度 Executor 或决定重试；
- 根据自然语言自行推断 Task 状态；
- 在断开时触发 Server shutdown。

飞书的本地 adapter 是 Server transport 的一部分，不是需要用户单独启动的
Client 进程。飞书用户和机器人会话仍按 ADR-0031 作为 Gateway Principal 与
Conversation source 处理。

### 4.3 “过程透明”不等于“展示思维链”

TUI 展示以下安全事实：

- 已收到请求；
- Planner 正在理解、查询哪些公开上下文类别、已提交什么计划摘要；
- Kernel 的授权或拒绝结果；
- 选用了哪个公共 Executor/Model 身份；
- 当前 Subtask、最近一条安全进展、已耗时；
- 验证、发布、结果认证和 artifact；
- 阻塞、权限、重试、恢复与错误。

TUI 永不展示：

- hidden chain-of-thought；
- 原始系统 prompt、内部 Planner prompt 或完整执行上下文；
- 未脱敏工具参数、stdout/stderr、Provider 响应；
- credential、token、secret、内部签名；
- Client 自行生成的“模型正在想……”推断。

## 5. 进程拓扑方案

### 5.1 方案 A：保留 foreground surface

Server 根据命令选择 TUI、Web 或 Gateway surface，surface 退出时关闭 Server。

优点：改动最小。

拒绝原因：这正是当前问题；Client 生命周期继续控制 Runtime 生命周期。

### 5.2 已批准方案：一个常驻 Server，多种 Client surface

```text
metawork tui ----------------------> Unix Gateway -------\
Browser Web -----------------------> HTTP/WebSocket ------> MetaWork Server
Feishu bot/user -> Feishu platform -> Feishu adapter ----/       |
                                                               v
                                                    AccountRuntime
                                                    Planner/Kernel/Exec
```

Server 启动后始终暴露：

- 本机 Unix socket：TUI 和未来本地 Client；
- loopback HTTP/WebSocket：Web 静态资源、Web Gateway、管理和 artifact API；
- 配置驱动的飞书 adapter：飞书配置有效时自动连接，无独立启动命令；
- health/status endpoint；
- 原子写入的 endpoint discovery manifest。

`metawork web` 只读取 discovery manifest、验证 Server health 并打开浏览器；
浏览器本身就是独立 Client。它不构造 Runtime，也不持有 Server 子进程。

这是推荐方案，原因是：

- 完整满足独立启动和独立退出；
- Web 不需要多一层本地代理；
- 复用现有 Management Server 的 loopback 安全模型；
- Server 仍是唯一拥有管理 projection 和 account administration facade 的进程；
- 飞书保持“Server 启动且机器人配置有效即可使用”的产品语义。

### 5.3 方案 C：每种 Client 自带本地 bridge

Web launcher 启动一个静态资源/HTTP bridge，bridge 再连接 Unix Gateway。

保留为未来远程部署选项，当前不推荐。它会新增 bridge 认证、API 转发、artifact
流、配置管理 RPC 和多进程版本兼容问题，却不改善本地产品体验。

## 6. 目标命令与行为

### 6.1 Canonical 命令

```bash
# Server
metawork server start   # 启动用户级常驻服务
metawork server stop
metawork server restart
metawork server status
metawork server doctor

# Client
metawork tui
metawork tui --conversation <id>
metawork web
metawork web --conversation <id>
```

飞书没有独立 CLI。Server 检测到有效的飞书机器人配置后自动建立连接并负责重连。

### 6.2 默认命令

`metawork` 等价于 `metawork tui`，但只启动 Client：

- Server 已运行：立即连接；
- Server 未运行：失败并输出一条可执行指令，例如
  `metawork server start`；
- 不静默自动启动 Server；
- TUI 退出码只描述 Client，不改变 Server。

`--connect`、`gateway run`、旧 Web foreground mode、script mode 和其他旧
启动形式全部硬切换到新的 canonical command，不保留兼容执行路径。

### 6.3 工作区契约

Server 启动不接收、不推断也不保存用户 Workspace。Workspace 是
Conversation 级持久事实：

- 新 Conversation 初始 `workspacePath = null`；
- 所有 Client 都通过 Gateway slash command 设置：

```text
/workspace /absolute/path/to/project
```

- TUI 直接提交该命令；
- Web 通过现有 Composer 提交同一个 `/workspace <path>` command，不新增或改版
  Workspace selector；未来若要增加可视化 selector，必须单独 review；
- 飞书用户也通过机器人消息提交同一个命令；
- attach 到已有 Conversation 时，如果已经存在有效 Workspace，可以直接恢复并
  明确显示；没有 Workspace 时 Client 必须提示先执行 `/workspace <path>`；
- Gateway 在任何语义 user message admission 前检查 Workspace；未设置时返回
  稳定错误 `workspace_required`，不启动 Planner；
- Server 把 path 视为不可信输入，执行绝对路径解析、realpath、目录存在性、
  Principal/account authorization 和目录可访问性检查；具体读写能力仍由
  Task/permission contract 决定；
- Workspace 只能在没有 active turn/Task 使用该 Conversation 时切换；冲突时
  返回 `workspace_busy`；
- 历史 Turn 保留自己的 Workspace reference，切换只影响后续 Turn；
- Workspace 事实进入 Conversation snapshot/replay，不进入 Server endpoint
  manifest，也不由 Server 进程 cwd 推导。

## 7. Server 生命周期

### 7.1 启动顺序

```text
读取安装与 account 路径
  -> 获取 runtime.lock
  -> 解析并固定 config revision
  -> 初始化 storage 和 RuntimeRegistry
  -> 完成 durable recovery
  -> 启动 Planner Host
  -> 启动 Unix Gateway
  -> 启动 loopback HTTP/WebSocket
  -> 配置有效时启动飞书连接器
  -> 可选启动 account timers
  -> 原子写 endpoint manifest
  -> 标记 ready
```

只有 ready 后 Client command 才可被 admission。
`server start` 返回后 Server 作为用户级常驻服务运行，不因所有 Client 断开而
自动 idle shutdown。只有显式 `server stop`、`server restart` 或操作系统服务
管理动作才停止它。

### 7.2 Endpoint discovery manifest

建议位置：

```text
~/.metawork/data/server-endpoints.json
```

建议内容：

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "startedAt": "2026-08-26T10:00:00.000Z",
  "serverVersion": "1.2.0-preview.0",
  "gatewayProtocolVersion": 2,
  "unixSocketPath": ".../gateway.sock",
  "webBaseUrl": "http://127.0.0.1:8788",
  "configurationRevision": "revision-id"
}
```

要求：

- temp file + rename 原子写；
- 文件权限限制为当前用户；
- Client 必须同时验证 PID、health 和 protocol；
- stale manifest 不得被当作在线 Server；
- manifest 不包含 Workspace、token、cookie 或 secret。

### 7.3 停止顺序

```text
关闭新 command admission
  -> 通知 Client Server draining
  -> 停止 HTTP/WebSocket 和 Unix accept
  -> drain ClientGateway / Conversation mailbox
  -> 按现有语义处理 active work
  -> 停 Planner Host / Runtime / repositories
  -> 删除 endpoint manifest
  -> 释放 runtime.lock
```

普通 Client 断开不进入此流程。

## 8. Client 生命周期与连接行为

### 8.1 TUI

- TUI launcher 自己 spawn AnyFusion-Pi client-only 进程，Server 不再 spawn 它。
- TUI 读取 manifest 并连接 Unix socket。
- TUI 可以创建新 Conversation 或显式 attach。
- attach 后读取 Conversation Workspace；未设置时突出提示
  `/workspace <path>`，并在设置成功前禁止语义任务提交。
- `/exit`、Ctrl-C 或终端关闭只 dispose transport 和 UI。
- 断线后进入 `reconnecting`，按有上限的退避重连并携带最后 sequence。
- 重连期间保留界面，禁止重复提交；恢复后从 replay reducer 重建相同状态。

### 8.2 Web

- Server ready 后 loopback Web endpoint 始终存在。
- `metawork web` 只执行 health/protocol 检查并打开 URL。
- 关闭浏览器 tab 不停止 Server。
- 多个 tab 可以观察同一 Conversation；输入仍由 Conversation mailbox 串行化。
- `web --conversation <id>` 只生成授权 attach URL，不把 account authority 放入 query。
- Web 继续使用现有 Composer 提交 `/workspace <path>`，不新增第二套 Workspace
  mutation API。

#### 8.2.1 Web preservation contract

当前 Web Client 已完成的展示和交互是本次改造的兼容基线，不是重构目标。必须
原样保留：

- password/token/bootstrap authentication 和 session cookie 行为；
- Session sidebar 的创建、搜索、浏览、激活、删除和清空；
- 一个 live Conversation 与历史 Conversation 只读浏览/安全激活；
- Conversation / Trajectory 双视图，以及 Composer 只出现在 Conversation；
- 草稿、附件上传和 tab 切换后的状态保持；
- turn history、live turn、Markdown final answer 和 terminal error；
- trace snapshot/delta、阶段、actor、status、时间和安全 details；
- Live Execution cards、Provider/Model/Executor 公共身份、elapsed time 和进展；
- Execution detail drawer、Execution timeline 和 Attempt 用户标签；
- Work Graph、依赖、并行组、runnable frontier 和 routing decision；
- result delivery/chunk/completion、完整性与 certification；
- artifact 列表、预览、折叠、下载和不支持格式提示；
- 配置、Provider、Model、Secret、activation、rollback 和 runtime state；
- 浅色、深色、跟随系统主题及偏好持久化；
- 当前响应式布局、信息密度、视觉层级和已有键盘/抽屉交互。

Server 对 Web 暴露的 HTTP、WebSocket、Gateway event 和 query projection 的并集
必须是当前 Web 所需字段与行为的超集：

- 当前字段不得删除、改名、降精度或改变语义；
- 当前事件顺序、幂等合并、session activation 和 result streaming 行为不得退化；
- 可以增加 Workspace、Server identity、protocol 和其他新字段；
- 新字段优先为 additive optional field；若必须升级协议，Server 侧 adapter 必须
  继续生成当前 Web projection；
- 不得为了复用 TUI reducer，让 Web 丢失 Trajectory、Work Graph、路由、Artifact、
  Settings 或执行详情；
- Server 内部可以统一事实来源，但 Web 保持现有组件、信息架构和交互语义。

本次允许的 Web 用户可见变化只有：

- `metawork web` 连接已常驻的 Server，而不是创建 Runtime；
- 新 Conversation 没有 Workspace 时，现有 Composer 显示
  `workspace_required` 引导，并只允许先提交 `/workspace <path>`；
- Server offline、draining 或 protocol mismatch 的连接状态提示。

### 8.3 飞书

- 飞书 SDK/webhook/WebSocket adapter 随 Server 启动。
- 飞书机器人配置完整时自动连接；配置未完成时保持 disabled，不影响 Server ready。
- 配置激活或连接中断后由 adapter 自动重连，不要求用户执行额外命令。
- 飞书消息仍规范化为统一 Gateway command，回复仍消费统一 Gateway event。
- 新飞书 Conversation 没有 Workspace 时，机器人提示用户发送
  `/workspace /absolute/path`；设置完成前不执行语义任务。
- pairing、审计、上传、回复和 Workspace authorization 都由 Server 权威控制。

## 9. TUI 信息架构

Server 负责返回 presentation-safe、完整、版本化和可重放的过程事实，不规定所有
Client 必须采用相同布局。Web、飞书和未来 Client 可以根据自己的媒介重新组织
这些事实。以下只定义本次批准的 TUI 落地方案。

### 9.1 总体布局

采用单一时间线，而不是“执行轨迹 + 对话”两个无限增长区域。

```text
┌ MetaWork ─ connected ─ workspace: metawork ─ 3m 12s ────────┐
│                                                              │
│  你                                                          │
│  分析 README.md 和 package.json，不修改文件……                │
│                                                              │
│  任务进度                                                    │
│  ● 理解  ● 规划  ● 授权  ◉ 执行  ○ 验证  ○ 交付             │
│                                                              │
│  ┌ 只读分析 README.md 与 package.json                 02:41 ┐│
│  │ Codex CLI · gpt-5.6-terra · 正在执行                     ││
│  │ 最近进展：正在检查 package scripts 与依赖边界             ││
│  │ 32 秒无新公开事件，Executor 仍在运行                      ││
│  │ [d 查看技术细节]  [c 取消任务]                            ││
│  └───────────────────────────────────────────────────────────┘│
│                                                              │
│  MetaWork                                                    │
│  最终结果将在这里以 Markdown 结果卡显示……                    │
│                                                              │
├ connected · busy · 输入 /help 查看命令 ──────────────────────┤
│ >                                                            │
└──────────────────────────────────────────────────────────────┘
```

窄终端下：

- 隐藏 workspace 次要信息；
- 阶段 stepper 改为垂直的当前阶段摘要；
- Subtask card 单列；
- 技术 details 默认折叠；
- composer 始终保留一行状态和输入区。

### 9.2 Turn 是第一组织单位

每次用户输入生成一个 `TurnViewModel`：

```ts
interface TurnViewModel {
  turnId: string;
  request: UserMessageView;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  activeStage: 'intake' | 'planning' | 'authorization' | 'execution' | 'verification' | 'delivery';
  stages: StageViewModel[];
  subtasks: SubtaskViewModel[];
  permission: PermissionViewModel | null;
  result: ResultViewModel | null;
  notices: NoticeViewModel[];
}
```

TUI 不直接 append 格式化字符串。它把 replay 和 live events 输入纯 reducer，再由
组件渲染当前 `ConversationViewModel`。

### 9.3 阶段 stepper

用户语言固定为：

```text
理解 -> 规划 -> 授权 -> 执行 -> 验证 -> 交付
```

映射：

- `intake` -> 理解；
- `planning` -> 规划；
- `authorization` / `routing` -> 授权；
- `execution` -> 执行；
- `verification` -> 验证；
- `delivery` -> 交付。

`routing` 作为授权阶段的可展开子步骤，不新增第七个主阶段。

每个阶段只有 `pending/running/completed/blocked/failed`，由 Server event facts
决定。Client 不根据时间或文本猜状态。

### 9.4 Subtask card

每个 Runtime canonical Subtask 只显示一张卡：

- Subtask 标题和交付类型；
- 公共 Executor / Provider / Model 名称；
- 当前状态和 elapsed time；
- 最近一条非重复 safe progress；
- silent heartbeat 的人类化摘要；
- artifact、warning、verification 状态；
- 折叠技术详情。

相同 `eventKey` 和 replayed `eventId` 必须幂等更新，不能重复追加。

### 9.5 权限交互

权限请求不能只显示“输入 `/approve`”：

```text
需要你的确认
Codex CLI 请求读取工作区外的 /path/to/file
原因：验证外部配置

[a] 仅本次允许   [d] 拒绝   [v] 查看详情
```

快捷键只是 command 的 UI 映射；Kernel 仍拥有授权语义。过期、已处理和冲突必须
显示明确状态。

### 9.6 最终结果

结果使用 turn-local 独立结果卡：

- Markdown 正文；
- `certified` / `uncertified` 状态；
- 结果完整性校验状态；
- artifact 列表；
- warning；
- 可复制、展开和滚动；
- 技术完成协议不直接显示给普通用户。

当 `result_chunk` 到达时，卡片原位流式增长，不能把结果插入旧 transcript 的
不稳定行号位置。

### 9.7 Composer

Composer 显示：

- `connected / reconnecting / offline`；
- `idle / busy / waiting permission`；
- 当前 Workspace，未设置时显示 `/workspace <path>` 引导；
- 当前可用动作；
- busy 时的取消快捷键；
- offline 时禁止提交并保留草稿；
- submit receipt 未确认前显示 `sending`，避免重复输入。

## 10. TUI Presentation Reducer

新增纯展示层：

```text
GatewayReplay + GatewayEventEnvelope
  -> validate and deduplicate
  -> reduceConversationView(previous, event)
  -> ConversationViewModel
  -> TUI components
```

Reducer 规则：

- 只消费版本化 public Gateway event；
- 用 `eventId` 去重、`sequence` 排序；
- 用 `turnId`、canonical `subtaskId` 和 `resultId` 关联；
- snapshot reset 后可确定性重建；
- 不调用 Server，不读取仓库，不执行自然语言语义判断；
- 不把 raw payload 直接打印；
- 未识别事件进入折叠的 compatibility notice，不破坏主界面；
- protocol 不兼容时 fail closed，并给出升级指令。

现有 `trace_delta` 已包含 phase/status/eventKey 和安全 details，第一版优先通过
规范化 presenter 消费它。只有在下列事实无法稳定得到时才升级 Gateway protocol：

- turn terminal/cancelled 状态；
- canonical Subtask identity；
- permission lifecycle；
- result certification；
- Server draining / protocol mismatch。

不为纯视觉字段修改 Kernel 或 Execution 领域事件。

## 11. 状态、错误与重连

| 场景 | Client 表现 | Server 行为 |
| --- | --- | --- |
| Server 未启动 | 清晰失败并显示启动命令 | 无 |
| Workspace 未设置 | 阻止语义提交并提示 `/workspace <path>` | 返回 `workspace_required` |
| Workspace 切换冲突 | 保留当前 Workspace 并解释 active work | 返回 `workspace_busy` |
| Client 退出 | 立即退出 UI | Task 继续 |
| 短暂断线 | 保留界面、reconnecting、禁重复提交 | Runtime 继续 |
| Server 重启 | 重试 health/socket，protocol 校验后 replay | durable recovery |
| replay cursor 过期 | 接收 bounded reset snapshot | 不返回截断中段 |
| protocol 不兼容 | 阻止输入并提示升级哪一侧 | 不接受不兼容 command |
| permission pending | 显示阻塞卡和快捷操作 | 等待 versioned resolution |
| Executor 静默 | 显示 elapsed/silent-for/last progress | 继续 heartbeat fact |
| Server draining | UI 显示维护状态，停止新 submit | drain 后退出 |

## 12. 安全要求

- Unix socket 和 manifest 仅当前用户可读写。
- HTTP/WebSocket 继续只监听 loopback，保留 Origin、bootstrap auth、cookie 和
  CSRF 防护。
- URL、manifest 和命令行不携带长期 secret。
- Server 从 trusted Principal 映射 account；`/workspace <path>` 是非信任请求，
  必须由 Server canonicalize 并按 Principal/account policy 授权。
- Event reducer 只接受 payload 大小、深度和 schema 校验通过的事件。
- TUI details 使用公共显示身份，不显示内部 modelRef、binding fingerprint、
  raw attempt context 或完整文件系统敏感路径。

## 13. ADR 与文档影响

实施前必须新增 ADR-0034，至少固定：

- Server 和 Client 的进程生命周期；
- canonical CLI；
- Web endpoint 属于 Server transport，不属于 Web Client lifecycle；
- 飞书 adapter 随 Server 自动启动、配置驱动连接且没有独立 CLI；
- Conversation 级 `/workspace <path>` 契约和 task-admission gate；
- Server composition 不再从进程 cwd 注入用户 `sourceRoot/userWorkspaceRoot`；
- Server 的 Web projection 是当前 Web HTTP/WebSocket/query contract 的兼容超集；
- Web 交互、展示、视觉和现有功能不因进程拓扑调整而重构；
- endpoint discovery、protocol negotiation 和 shutdown；
- 对 ADR-0031 “coexist in one Server process”实施结论的修订。

实施时同步：

- `CONTEXT.md`；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `docs/current/account-runtime-and-gateway-operations.md`；
- `AGENTS.md`，仅在入口导航变化时更新；
- `README.md` 的启动示例；
- installer、smoke 和 release notes。

## 14. 验收标准

### 14.1 独立进程

1. `metawork server start` 后不启动 TUI 或浏览器，并作为用户级服务持续运行。
2. 分别启动两个 TUI 和一个 Web tab，它们连接同一 Server。
3. 关闭任意或全部 Client 后，Server PID、Runtime 和 active Task 保持。
4. Client 重启后通过 replay 恢复同一 Conversation，不重复消息或结果。
5. `metawork web` 在 Server 未运行时不构造 Runtime，只给出明确错误。
6. 新 Conversation 未设置 Workspace 时，TUI、Web 和飞书都拒绝任务并提示同一个
   `/workspace <path>` 命令。
7. 两个 Conversation 可以分别绑定不同 Workspace，Server 进程无需重启。
8. 飞书配置有效时随 Server 自动连接，连接中断后自动恢复，没有 `feishu run`。
9. 同一 installation 不能启动第二个 Server；错误包含现有 PID 和 status 命令。

### 14.2 Web preservation

1. 当前 Web 的 Session sidebar、Conversation、Trajectory、Composer、附件、
   Execution、Work Graph、Routing、Result、Artifact、Settings、Authentication
   和 Theme 行为全部通过现有回归。
2. topology 切换前后的 Web 浏览器 golden flow 和关键截图没有非预期差异。
3. 当前 `web/src/api/types.ts`、`session-types.ts`、`gateway-types.ts` 消费的字段
   均可从 Server 获取；新 contract 只增加字段，不删除或改变现有字段语义。
4. replay/live、result streaming、execution detail 和 artifact preview 的顺序、
   去重、完整性和交互不退化。
5. Web 不被迫采用 TUI 的六阶段卡片布局；两端只共享 Server facts。
6. 除 Workspace required 和 Server connection state 外，不出现新的 Web
   用户可见交互变化。

### 14.3 TUI

1. 产品标题只显示 MetaWork，不把 AnyFusion 作为主品牌。
2. 一次用户请求只出现一次，并形成一个完整 Turn。
3. 主界面能在 3 秒内回答：当前阶段、当前 Subtask、是否正常运行、已耗时多久。
4. 默认界面不显示 socket path、raw ID、raw payload 或内部英文事件名。
5. 技术详情可展开，但仍是脱敏、去重和用户可读的。
6. result streaming 原位更新，最终结果明显高于 trace。
7. 同一 result 只显示一次；snapshot、final answer 和 result stream 不得重复正文。
8. 当前 Turn 默认不展示无关历史 Task 队列，只有显式打开 Task 面板后才显示。
9. replay 和 live delivery 产生完全相同的 `ConversationViewModel`。
10. 80x24、120x36 和宽屏终端均无关键操作截断。
11. 中文、英文、长路径、宽字符和窗口 resize 均正确。
12. 自动测试证明没有 hidden reasoning、prompt、secret、stdout/stderr 泄漏。

## 15. Review 结论

2026-08-26 已确认：

1. 一个常驻 Server 提供 Unix、loopback HTTP/WebSocket 和飞书 transport。
2. `metawork` 是纯 TUI Client；Server 缺失时提示 `metawork server start`，
   不自动构造 Runtime。
3. Server 启动不绑定 Workspace；所有 Client 统一通过 `/workspace <path>` 设置
   Conversation Workspace，未设置时不能执行任务。
4. 不提供 Script Client。
5. 旧启动命令和旧 foreground surface 全部硬切换，不保留第二套路径。
6. 飞书没有独立启动命令；Server 启动且机器人配置有效时自动连通。
7. Server 返回所有安全过程事实，各 Client 自主决定展示；首个 TUI 按本文的
   Conversation 时间线、六阶段、Subtask card 和 Result card 实施。
8. 当前 Web Client 是不可回归的体验基线；Server 新 contract 必须至少是当前
   Web 展示信息的超集，本次不改 Web 的展示和交互逻辑。
9. 当前没有遗留的产品决策待确认，可以进入 ADR 和生产实施。
