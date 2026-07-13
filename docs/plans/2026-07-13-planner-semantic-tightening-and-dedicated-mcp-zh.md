# Planner 语义职责收紧与专用 MCP 改造

日期：2026-07-13

## 总结

- 所有自然语言语义判断统一进入 Codex `PlanningAgent`；代码只保留 slash command、显式 ID、路径、URL、附件等确定性解析。
- Planner 使用镜像内独立 Codex 配置、一个核心 Skill、原生只读工具和专用只读 stdio MCP。
- 上下文改为最小启动信息，其余任务、会话、执行器状态由 Planner 按需查询。
- 执行器实例的创建、探测、回退由获批后的 Runtime 负责，Planner 只选择 AgentClass。
- 实施阶段新增 ADR，记录本次 grill 形成的决策。

## 核心接口与 Planner

- 将 `PlanningAgentPlan` 升级为 v2，不支持 v1 双读；唯一新增字段为：
  - `task.priority = { level: 'normal' | 'high' | 'urgent', reason: string } | null`
  - `plan_work_graph`、`resume_task`、`recover_blocked` 必须提供非空 priority。
  - 直接回复、澄清、状态查询、清理和 no-action 必须为 `null`。
  - JSON Schema 从 Zod 契约生成并随镜像构建，避免双份手写定义。
- 收紧 `PlanningContext`，只保留用户输入、session/source、授权边界和超时；移除 recentTasks、agentClasses、currentFocus、rule hints 和默认执行器等被动注入。
- 新增 Planner 专用 Codex runner：
  - 使用独立 `CODEX_HOME`、核心 Planner Skill、`--output-schema`、`--json`、`--ephemeral` 和只读 sandbox。
  - 保留原生只读工具及专用 MCP；关闭写工具、Web、apps、多代理等无关能力。
  - 解析 Codex JSONL 中的最终输出和工具事件，不再复用面向执行器的通用 `LlmBridge` 参数。
  - Schema 修复重试仍失败、Codex 超时或 MCP 不可用时，返回无状态变更的安全澄清，不走旧规则兜底。
- PolicyKernel 开始执行现有风险契约：状态变更 Plan 的 `requiresConfirmation=true` 时强制转成澄清；后续确认/取消由 Planner 查询最近规划决定后重新规划。
- 对现有 task control 增加强校验：非法 status/clear scope 必须拒绝或澄清，禁止把未知 clear scope 默认成 `all`。

## Planner MCP 与语义清理

- 新增独立 `dist/planner-mcp.js` stdio 入口，使用只读 SQLite 连接，提供五个资源型工具：
  - `search_tasks({ query?, statuses?, limit? })`
  - `get_task_context({ taskId })`
  - `get_current_session_context({ limit? })`，session 由宿主绑定，模型不能查询其他 session。
  - `get_runtime_state()`，返回当前焦点、运行中及阻塞任务摘要。
  - `list_executor_classes()`，返回数据库静态能力和 WorkUnit 实时容量汇总。
- 查询结果必须有数量和长度上限；不读取文件正文，不暴露环境变量、凭据、任意会话或长期偏好。
- 核心 Planner Skill 明确：
  - “继续、之前完成了吗”等输入先查当前会话/任务事实。
  - 新任务不查询无关历史；需要分派时才读取执行器目录。
  - 不猜测 taskId、AgentClass 或阻塞状态；证据不足时澄清。
- 删除生产链路中的语义关键词判断：
  - 移除 `RuleHintsProvider` 及 PlanningContext hints。
  - 所有持久化 Task 都视为 durable，移除 `filterDurableTasks` 和文本 durable 判断。
  - 移除风险、优先级、继续、恢复、状态、清理范围等自然语言关键词助手；调度原因直接使用 `plan.task.priority.reason`。
  - 用户触发的阻塞恢复完全依据 Plan；定时器、依赖状态等系统触发规则继续保持确定性。
  - 移除 Planner 前面的自然语言“记住……”和高置信偏好自动写入；保留 `/memory add` 等明确命令。
  - `task-routing.ts` 剩余 scope 类型迁入任务域后删除；已不存在的 `execution-strategy-planner.ts` 不重新引入。

## 执行器目录、审计与容器

- AgentClass 启动时只插入缺失的内置记录，读取时不再重复 seed 或覆盖数据库内容。
- 遗留 `availability` 列暂不迁移，但新代码完全停止读写；静态能力来自 AgentClass，实时健康只来自 WorkUnit。
- Runtime 分派流程：
  - 先 claim 健康 idle WorkUnit。
  - 没有容量时创建 `starting` WorkUnit，通过 `runtimeCheckCommand`，或缺失时通过 Adapter 可用性探测。
  - 成功后转 `idle` 并 claim；失败记为 `failed` 和事件，然后按 Plan 候选顺序尝试下一个 AgentClass。
  - 全部失败时将任务置为 blocked 并持久化原因，不重新调用 Planner。
  - 不再预置代表“可用”的虚假 executor idle WorkUnit。
- 新增 `planner_runs` 与 `planner_tool_calls` 审计记录；保存状态、耗时、工具名、候选 ID/数量及截断脱敏摘要，不保存完整会话、文件内容或秘密。
- 构建完整运行镜像：
  - 镜像内编译 `dist/index.js`、`dist/planner-mcp.js` 和 v2 output schema，并内置 Planner/Executor Codex 配置、Planner Skill、entrypoint 及其他执行器模板。
  - 容器内分别渲染 Planner 与 Executor 的 CODEX_HOME；共享 API 凭据环境变量，但配置和 skills 不共享。
  - 移除宿主 `dist`、Codex/PI 配置和 entrypoint 的运行时 bind mount；宿主只注入 secrets/env，并使用专用 workspace/data volume。
  - Docker shell 工作流在源码变化后重建镜像，不再在宿主构建并挂载 dist。
- 实施时新增 ADR-0015，记录上述决策，并明确取代 ADR-0014 的自然语言记忆快路径例外及 ADR-0013 的固定 executor pool；同步当前技术概览和 Docker 使用说明。

## 测试与验收

- Schema/Kernel：v2 priority 必填矩阵、无 v1 双读、非法 scope 不得清空全部任务、风险确认必须阻止状态变更。
- MCP：任务搜索、详情、恢复上下文、session 隔离、执行器容量汇总、查询上限和只读保证。
- Planner runner：双 CODEX_HOME 隔离、核心 Skill 注入、JSONL/MCP 事件解析、修复重试、超时和 fail-closed。
- 语义回归：新任务、直接聊天、继续任务、查询历史状态、阻塞恢复、清理范围、风险确认和 urgent/high/normal 持久化；断言不再调用关键词助手。
- Executor Runtime：已有实例 claim、按需探测成功、首选失败后候选回退、全部失败转 blocked。
- 容器：验证运行镜像包含全部产物和两套隔离配置，且启动脚本不挂载宿主 dist/Codex 配置。
- 验证命令：
  - `npm run lint`
  - `docker build -f Dockerfile.test -t metaclaw-test .`
  - `docker run --rm metaclaw-test`
  - 构建运行镜像并在容器内执行真实 Planner/MCP smoke。
- 全部通过后提交，建议提交信息：`refactor: centralize semantic planning in codex planner`。

## 明确暂缓

- 不扩展 task control 的判别联合或完整副作用 Schema；留待后续专项评审。
- 不增加偏好、长期记忆、跨会话搜索、文件正文读取等 Planner 工具。
- 不实现并行执行、抢占、探测失败后的 Planner 重规划或 AgentClass 版本化覆盖。
