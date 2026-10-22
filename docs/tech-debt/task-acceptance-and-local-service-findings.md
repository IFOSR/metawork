# 任务验收、Workspace 交付与本地常驻服务修复方案

- **记录日期**：2026-10-21
- **状态**：已完成源码实施与原生自动化验收（2026-10-21）；安装升级、真实模型与图形界面实机验收未执行。下文现场事实保留为修复前记录。
- **触发场景**：任务 `task_plan_event_proposal_275aeecb2290e4745cb1c429a074b2ef9b5dba1b5fee34d415953d6900bb1051` 为 Rust System One 服务生成了代码，但用户看不到“接受并交付”入口、不知道代码落在哪里，并要求启动后台服务时只收到启动命令文本。
- **关联契约**：[ADR-0024](../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)、[ADR-0025](../adr/0025-single-task-concurrency-and-git-publication.md)、[ADR-0032](../adr/0032-result-first-delivery-and-completion-certification.md)、[ADR-0035](../adr/0035-workspace-scoped-conversation-organization.md)、[ADR-0041](../adr/0041-single-tui-convergence-and-gateway-read-only-queries.md)。

## 一、结论

这次问题由四条链路同时断开造成：

1. `accept_uncertified_result` 把“当前待决策 receipt 的 Attempt”和“safe projection 所属的原始 Attempt”错误地当成同一个身份；`contract_correction` 后接受必然失败。
2. `TaskView` 已经声明 `accept_result` / `retry_attempt`，但 Web、TUI、Feishu 没有把动作渲染成用户可执行入口。
3. 执行隔离 Worktree 与用户 Workspace 的公开交付目录没有形成清晰的产品契约；用户只应看到自己的 Workspace 和任务目录，不能看到内部 Worktree、Attempt、裸仓库或日志路径。
4. “启动后台服务”没有作为可持续、可检查、可停止的 Runtime 动作落地，且启动验证被另一个等待用户决策的 Subtask 阻塞。

内部 Worktree 仍然是必要的安全边界，但它不是用户交付目录，也不能出现在普通客户端输出中。

## 二、现场事实

本机当前实例的用户路径如下：

```text
MetaWork 源代码：
/Users/yuanjubian/program/metawork

MetaWork 安装根目录：
/Users/yuanjubian/.metawork

当前生效 Runtime：
/Users/yuanjubian/.metawork/app/current

本次任务绑定的用户 Workspace：
/Users/yuanjubian/program/harnessclash
```

本次任务的 Subtask 状态为：

```text
backend-service  done
web-ui           awaiting_decision
verification     ready，但等待 web-ui
```

代码实际生成在 MetaWork 的内部隔离目录，而不是用户 Workspace。该目录只作为排查证据，不属于用户交付路径：

```text
/Users/yuanjubian/.metawork/accounts/local-default/workspace-store/workspaces/...
```

本次用户 Workspace 下没有生成预期的 `systemone-rust/` 项目目录，也没有发现 System One 服务监听 `127.0.0.1:8080`。因此当前事实是：代码在内部执行结果中，服务没有启动。

## 三、公开路径与安全边界

### 3.1 用户只看到两类路径

用户界面、Gateway、CLI、TUI 和 Feishu 只允许展示：

```text
用户 Workspace：/absolute/path/to/workspace
任务目录：     /absolute/path/to/workspace/<public-task-directory>
```

不得展示：

- `workspace-store/workspaces/...`；
- Attempt 目录；
- 内部裸仓库；
- Runtime 临时目录；
- 内部日志绝对路径；
- 仅用于审计的执行身份路径。

内部路径可以留在受保护的本地诊断和审计记录中，但不能进入普通产品响应或用户交付文件。

### 3.2 任务目录必须在任务创建时确定

每个需要文件或 Workspace 修改的 Task 应持久化一个公开任务目录的相对路径，例如：

```text
metaclaw-tasks/rust-system-one-<short-task-id>
```

Runtime 根据已绑定 Workspace 的 canonical path 解析绝对路径；Planner 不直接传绝对路径，也不能越过 Workspace 边界。

任务类型可以采用两种模式：

- 新建项目或独立交付物：在 Workspace 下创建独立任务目录；
- 修改已有项目：使用用户明确指定的现有项目目录。

任务目录确定后，重试、恢复和重新连接不得改变它。

## 四、P0：修复 Attempt 与 Result 的归属校验

### 4.1 错误链路

正常的 correction 流程是：

```text
primary Attempt
  -> 生成 safe projection object
  -> completion 不完整
  -> contract_correction Attempt
  -> correction receipt 复用 primary 的 safeProjectionId
  -> 用户接受并交付
```

当前 `task-cancellation-coordinator.ts` 取最新的 `uncertified_result` receipt，并将它的 `attempt_id` 与 `safeProjectionId` 一起放入快照。`kernel-execution-runtime.ts` 随后要求：

```text
object.attemptId === action.attemptId
```

在 correction 场景下，实际关系是：

```text
action.attemptId = correction receipt
object.attemptId = primary Attempt
```

因此“结果不确定 -> 纠正重试 -> 用户接受”会固定报：

```text
safe uncertified result failed deterministic acceptance checks
```

### 4.2 修复方案

在快照阶段建立一个明确的 pending result pair，而不是把最新 receipt 的 Attempt ID 和 Result ID 当成同一身份：

```text
decisionAttemptId      当前待处理 receipt
resultObjectId         receipt 声明的 safeProjectionId
resultOwnerAttemptId   safe projection object 实际所属 Attempt
sourceAttemptId        correction receipt 的来源 Attempt
```

Runtime 接受校验应满足：

1. `action.attemptId` 必须对应当前的 `uncertified_result` receipt；
2. `action.resultId` 必须正好是该 receipt 声明的 `safeProjectionId`；
3. Result Object 的 Task、Subtask、Generation 必须匹配；
4. Result Object 所属 Attempt 必须是当前 receipt 自身，或是 correction receipt 的 `sourceAttemptId`；
5. correction 场景还要验证 source receipt 与 Result Object 的引用关系一致。

不能简单放宽为“只相信 `object.attemptId`”，否则可能把一个合法的 Result Object 接到错误的用户决策上。

建议抽出统一的只读解析器，供以下路径复用：

- `task-cancellation-coordinator.ts` 的 pending snapshot；
- `kernel-execution-runtime.ts` 的接受校验；
- `TaskView` 的 pending decision 投影；
- blocked 状态下的 safe result 展示；
- publication worker 的 safe projection 校验。

### 4.3 必须新增的测试

- primary 直接生成 uncertified result，接受成功；
- primary 失败后由 contract correction 复用 primary safe projection，接受成功；
- correction receipt 指向错误 Result Object，接受失败；
- Result Object 属于其他 Task、Subtask 或 Generation，接受失败；
- 重复提交同一接受请求保持幂等。

## 五、P0：补齐用户决策入口

`TaskView` 已经有 `pendingDecision.actions` 和 `nextAuthorizedAction`，应让所有客户端消费同一个投影。

### 5.1 用户动作

当状态为“需要处理”且原因是 `uncertified_result` 时，显示：

```text
接受并交付
重新执行
```

两个动作必须携带 Task、Generation、Graph Revision、Subtask 和 Attempt 的期望身份，避免旧按钮操作新结果。

建议 Gateway 使用明确的控制命令：

```text
accept_task_result
retry_task_attempt
```

CLI 保留：

```text
/task accept-result <taskId>
/task retry-result <taskId>
```

旧按钮或任务状态已经变化时，返回可理解的过期提示并刷新 TaskView，不静默失败。

### 5.2 两个动作的语义

**接受并交付**：

- 再次做确定性身份、文件、安全和发布检查；
- 不重跑原 Executor；
- 发布到公开任务目录；
- 发布和交付成功后才释放 Subtask done、Task 完成及下游 handoff。

**重新执行**：

- 保留原 Attempt、receipt 和 Result Object；
- 创建新的受授权 Attempt；
- 对可能已经发生的外部副作用不自动重复执行；
- 新 Attempt 仍使用同一个公开任务目录，除非用户明确创建新任务。

## 六、P1：公开 Workspace 交付

### 6.1 发布状态

内部 Git 集成不应直接等同于用户已经拿到代码。用户可见状态应区分：

```text
已生成内部结果
等待用户接受
正在发布到任务目录
已发布到任务目录
发布失败
```

只有真正写入用户 Workspace 下任务目录后，才显示“已交付”。

### 6.2 普通目录发布

对非 Git Workspace：

1. 记录任务目录的初始快照或哈希；
2. 用户接受后检查外部修改；
3. 无冲突时原子写入；
4. 有冲突时暂停并列出冲突文件；
5. 返回公开任务目录的绝对路径和相对文件列表。

对 Git Workspace：使用受控分支和合并，但最终仍要确认用户 Workspace 的实际文件状态。

### 6.3 任务详情

任务详情只显示：

```text
Workspace: /Users/yuanjubian/program/harnessclash
任务目录: /Users/yuanjubian/program/harnessclash/metaclaw-tasks/...
代码状态: 待发布 / 已发布 / 发布失败
交付文件: 相对任务目录的文件列表
```

不显示内部 Worktree、Attempt、裸仓库或日志路径。

## 七、P1：后台服务成为受管 Runtime 动作

用户提出“启动服务”时，Planner 应将其识别为有外部副作用的工作请求，并交给具备命令执行能力的 Executor；Planner 本身仍不能获得 shell 或进程控制权限。

### 7.1 启动契约

服务启动动作至少要持久化：

```text
公开任务目录
启动命令和参数
环境变量引用（不保存密钥明文）
监听地址和端口
健康检查地址
服务标识
启动、停止、重启策略
```

### 7.2 启动顺序

```text
代码执行
  -> 发布到公开任务目录
  -> 从公开任务目录启动
  -> 健康检查
  -> 返回服务状态和访问 URL
```

Executor 退出后，服务不能因为失去父进程而被误杀。Runtime 需要记录服务状态，支持：

```text
/service status <serviceId>
/service logs <serviceId>
/service stop <serviceId>
/service restart <serviceId>
```

用户不需要看到 PID、内部日志文件或执行 Worktree 路径。

### 7.3 失败语义

- 服务未启动：明确显示启动失败阶段和原因；
- 启动成功但健康检查失败：显示服务已启动但未通过健康检查；
- 服务已运行：不得重复启动；
- Server 重启后：恢复或重新确认服务状态；
- 服务停止：任务结果和代码交付不回滚。

## 八、P1：调整 Work Graph 依赖

当前任务中 `verification` 因 `web-ui` 等待用户决策而没有执行机会。Planner 应按真实交付依赖拆图：

```text
backend implementation
        |
backend build/API smoke
        |
publish + start service
        |
service health verification

web implementation
        |
web UI verification
```

如果完整服务必须同时包含前端和后端，启动节点可以依赖两个发布结果；但后端 API 自验不应被无关的 UI 验收阻塞。

“写代码”“发布代码”“启动服务”“健康检查”不能隐藏在一个只返回文字报告的泛化 verification Subtask 中。

如果现有 Task 已有活动 Work Graph，用户要求追加一个明确动作时，应提供受控 follow-up generation 或单步 Runtime 动作，不应强制重新规划或重跑整张图。

## 九、实施顺序

### 阶段一：正确性闭环

1. 修复 Attempt/Result 归属解析；
2. 补 primary/correction 接受测试；
3. 验证接受动作仍经过 publication 和交付检查。

### 阶段二：用户决策入口

1. Gateway 增加接受/重试控制命令；
2. Web、TUI、Feishu 消费统一 TaskView 动作；
3. CLI 增加明确的重试命令；
4. 处理过期按钮和重复提交。

### 阶段三：公开 Workspace 交付

1. Task 创建时持久化公开任务目录；
2. 实现普通目录和 Git 目录的发布确认；
3. 任务详情显示用户 Workspace 和任务目录；
4. 禁止客户端输出内部执行路径。

### 阶段四：服务生命周期

1. 定义服务启动、健康检查、停止和重启契约；
2. 实现 Runtime 服务记录和进程恢复；
3. 让 Planner/Executor 任务返回真实启动结果；
4. 按真实依赖重排服务启动和 UI 验证。

## 十、验收矩阵

### 决策与结果

- primary uncertified result 可以接受并交付；
- contract correction 复用 primary safe projection 时可以接受并交付；
- 错误 Task、Subtask、Generation 或 Result Object 会被拒绝；
- 接受不重复执行 Executor；
- 重试保留历史 Attempt 并创建新 Attempt。

### 路径与交付

- 用户能看到 Workspace 绝对路径；
- 用户能看到稳定的任务目录绝对路径；
- 代码和文件最终出现在用户任务目录；
- Web、TUI、Feishu、CLI 不显示内部 Worktree 路径；
- 发布冲突和发布失败都有明确状态。

### 服务

- 用户要求启动服务时实际启动进程，而不是只返回命令；
- 服务从公开任务目录运行；
- 健康检查通过后才报告服务可用；
- 支持查询、停止、重启和 Server 重启后的状态恢复；
- 服务启动失败不会伪装成代码任务完成。

### 状态与依赖

- 用户主状态只使用“等待中、执行中、需要处理、已结束”；
- `blocked` 和 `no runnable Subtask` 只留在内部诊断；
- 独立的 API 验证不被无关 UI 验收阻塞；
- 所有客户端从同一 TaskView 投影动作和状态。

## 十一、明确不做

- 不向 Planner 增加 shell、进程或文件系统控制权限；
- 不向用户暴露内部 Worktree、Attempt、裸仓库或日志路径；
- 不把用户接受变成跳过安全检查的强制成功；
- 不让重试覆盖旧 Attempt 或自动重复不确定的外部副作用；
- 不为普通任务生成无关的证明报告；
- 不新增第二套调度器或第二套任务状态系统。

## 十二、文档与发布要求

实施前后需要同步更新：

- `CONTEXT.md`：公开 Workspace、任务目录、发布和服务生命周期边界；
- `docs/current/technical-overview.md`：执行隔离与公开交付路径；
- ADR-0032：Attempt/Result 归属和 correction safe projection 关系；
- ADR-0035：Workspace 下公开任务目录；
- ADR-0025/0024：发布目标与受管服务进程边界；
- 本文档：记录实施状态、测试证据、安装验收和剩余平台门槛。

在 P0 正确性和 P0 用户动作入口关闭之前，不应把这条任务链路宣称为可用；在公开 Workspace 发布和服务生命周期验收关闭之前，也不应把“直接启动后台服务”宣称为已支持。

## 十三、实施与验收记录（2026-10-21）

### 服务启动状态纠偏（2026-10-21）

现场复核发现，公开目录是否已经交付与目录中是否存在可启动的服务规格被错误合并：当代码文件已发布但缺少 `.metawork-service.json` 时，服务启动链路会误报“代码尚未发布到用户任务目录”。现已拆分这两个事实：公开目录按已发布文件、路径完整性和交付状态判断；服务规格单独按已发布的 `.metawork-service.json` 校验。缺少规格时统一提示“代码已发布，但任务目录中没有可启动的服务规格”，不会根据 README、Cargo 配置或其他文件猜测命令。Kernel、Runtime 和受管服务回归测试已覆盖已发布、未发布、规格缺失和非法规格场景。

### 已交付行为

| 文档要求 | 实施与证据 |
| --- | --- |
| primary / correction 结果归属 | `safe-result-identity.ts` 与 `pending-task-result.ts` 统一只读解析；校验账户、Task、Generation、Revision、Subtask、decision Attempt、source receipt 和 Result。错误身份拒绝；重复接受幂等。 |
| 接受与重新执行 | Gateway 六字段期望身份、Web/Desktop 按钮、单 TUI 命令、签名飞书动作及 CLI 已接通。接受走原安全检查和 publication，不再运行 Executor；重试保留历史并限制不确定副作用。 |
| 公开目录与实际交付 | Task 创建时固定目录；支持明确指定的 Workspace 内现有项目子目录。普通目录分批预检、暂存和失败回滚；新目录整体 rename。Git 受控分支和 checked fast-forward 实际更新用户树。冲突不覆盖用户文件。 |
| 完整代码与下载附件 | edit delta 的新增、修改和删除均发布；代码文件事实与 `fileOutputs` 下载附件独立。Runtime、Gateway、飞书共用公开投影，兼顾既有附件事实；代码文件不会因未声明下载而消失。 |
| 内部路径与密钥 | 公共文本、结果内容及日志脱敏；包含内部执行路径的文本交付文件拒绝发布。普通客户端展示 Workspace、任务目录、相对文件、状态和冲突。 |
| 服务生命周期 | Kernel 授权的 Runtime 服务管理；持久化规格/状态/操作阶段，从经过校验的公开目录启动，真实 HTTP 健康检查，查询/日志/停止/重启及 Server 恢复。进程组受控，服务命令异常退出会清理子孙进程。 |
| 图依赖与有界追加动作 | Planner 明确拆分后端、API 和 UI 依赖；独立 frontier 不被另一个节点待验收阻止。已有任务支持显式服务动作，无须重跑整张图；健康检查失败阻止 Task done。 |
| 持久化 | SQLite schema 51；50→51 事务迁移、失败回滚、重复打开、历史公开目录保留、账户隔离和不可变服务规格测试通过。Docker 数据卷版本同步为 51。 |

### 用户视角案例

`tests/e2e/task-result-service-acceptance.test.ts` 的六个案例通过真实
Session → Kernel → SQLite → Git → 用户目录链路，读取实际文件并发起 HTTP
请求；Planner 和执行响应由确定性测试后端提供，未调用真实模型：

1. 选择“重新执行”：旧 receipts 保留，新 Attempt 产生，任务目录不变，目录中读到新内容。
2. UI 等待接受时，独立后端 API 验证仍执行，并实际取得 HTTP 200。
3. 选择“接受并交付”：原结果写入公开目录，Executor 调用次数不增加；重复接受仍不增加调用。
4. 指定已有项目：读取原文件并在原项目子目录更新，未生成另一个项目目录。
5. 请求实现并启动服务：真实进程从公开目录运行，HTTP 健康检查成功才完成 Task。
6. 服务返回 HTTP 503：用户状态为需要处理，Task 不会 done；修复就绪条件并显式重启后才完成，无须重跑 Executor。

服务层另有 11 个案例覆盖真实 Server 进程退出后的接管、同服务并发与操作重放、
端口冲突、账户隔离、密钥脱敏、健康失败、停止/重启和子孙进程清理。
TUI 的控制器、结果动作与渲染共 54 个测试通过；Web 动作 SSR 三例、飞书
动作及 Gateway 协议也已验证。另有生产 Gateway 回调回归验证“只有代码、
没有下载附件”仍显示交付文件。

### 验证命令与范围

- `npm test`：最终结果见实施计划中的关闭记录。
- `npm run lint`、`npm run build`：根服务和 Web 类型检查、构建。
- `planner/AnyFusion-Pi`：`npm run check`、`npm run build:offline`；coding-agent
  下运行 controller / result-actions / render 三组单 TUI 聚焦测试。
- 无需生成额外业务报告或证明文件；案例只使用隔离临时 Workspace、数据库及服务。

### 安装与平台门槛

本次变更在源码工作区完成，未升级 `~/.metawork/app/current`，未操作现场任务
或已有用户服务，因此不声称最初记录的 System One 实例已经交付或启动。
本机没有 Docker，容器回归未运行；真实飞书消息和真实模型 Planner/Executor
验收未执行。未创建提交，未对外发布安装包。

随后按用户试用要求生成本地 Apple Silicon DMG：
`Release/MetaWork-0.1.19-task-acceptance-services-20261021-arm64.dmg`。
已完成完整签名 inventory、挂载镜像与当前 Runtime/Web/Planner 哈希比对、
Electron 实际干净安装及设置操作，以及隔离 Finder 升级。升级使用 schema 50
测试数据库，确认迁移至 51、原配置和测试数据保留、两次重新打开及退出后 Server
继续运行。安装测试未调用真实模型，未替换用户现有应用或操作现场任务。
构建身份、校验和与证据路径见实施计划的“本地试用 DMG”记录；用户仍需安装后
试用真实模型下的接受、重试、公开交付及受管服务场景。
