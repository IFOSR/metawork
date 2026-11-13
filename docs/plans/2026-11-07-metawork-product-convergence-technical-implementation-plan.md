# MetaWork 产品与架构收敛技术实施方案

- 方案日期：2026-11-07
- 状态（2026-11-10）：按已接受 ADR-0055 分批实施；整体未验收，最新事实见 Review 报告
- 上位计划：[产品与架构收敛实施计划](2026-11-07-metawork-product-convergence-implementation-plan.md)
- 需求依据：[MetaWork 产品需求](2026-11-07-metawork-product-requirements.md)
- 架构决策：[ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)，已于 2026-11-07 接受；Owner 豁免交叉评审，以 D1–D14 为准

本文把上位计划的 Phase 0–7 拆成可单独编码、验证和回滚的技术批次。每个批次开始前仍需确认其输入、依赖、Owner 与验收命令；未关闭的产品决策和阶段门不能由本文推定为已接受。

## 1. 实施原则与当前状态

### 1.1 不可变约束

1. Manager 负责用户意图、任务图、重规划语义与最终汇总；不选择 Agent/model，不写运行时存储，不启动 Executor。
2. Router 对每个可执行 Subtask 作 Agent/model 决定并直接进入派发链，不等待 Kernel 或第二审批。Router 只返回可记录的决策事实，不自行写库或启动进程。
3. Task Runtime 负责准入、生命周期、资源占用、Attempt、机械恢复、完成门禁与 Workspace 发布；它不重新解释用户语义或复制 Router/Manager 策略。
4. Executor/Harness 负责一次执行中的模型循环和工具错误恢复；Host 负责工作区、进程、密钥、网络与操作系统边界。Manager 的许可判定不能放大 Host 能力。
5. 移除 Kernel 不等于移除 Task、Attempt、Permission、Result、Workspace publication、usage 等耐久事实。每个事实先确定新 Owner 和幂等应用方式，再删除旧账本和读写路径。
6. 新版本只创建唯一的新 schema。识别到旧本地数据库时明确失败并给出用户可执行的重置说明；程序不得静默迁移、自动删除或部分打开旧库。官方账号、License、订阅和支付事实由 `official-server` 保持独立。
7. 用量仅表示 Token。任何受支持的模型调用都需形成完整 usage fact；运行时不存模型价格、成本金额或金额待确认状态。官方订阅付款仍是独立商业事实。
8. 当前单活跃 Task 行为保持：运行中的 Task 完成前拒绝同一 Conversation 的新工作输入。本次不实现运行中改向、追加任务或 Attempt 中断。
9. 不选择云端/本机部署拓扑。Server 只增加可配置监听地址、非回环认证与授权、允许来源列表；内部服务保持回环。
10. 清扫遵循 ADR-0055 D12–D14：本地 Docker/专用测试退役，原生 macOS arm64 + Web 是本轮验收范围；Linux/Desktop/飞书延期；Windows 代码保留但不维护，不能以旧计划要求其删除。`official-server` Docker 独立保留。

### 1.2 当前实施状态与历史基线

2026-11-07 的 B0.2 基线为 44 failed / 4562 passed / 40 skipped，属于历史排障记录；不作为当前失败数。ADR-0055 已接受并由 Owner 豁免交叉评审，不能再把原稿 Proposed 或待签字表当作编码阻塞。

截至 2026-11-10，Kernel inbox/decision/application ledger 已移除，直接准入、Task Runtime facade 和生产 Router 接线已存在。Review R-01～R-28 补齐 Memory/Token 页面、真实 Pi 进程与安装打包、启动/去重/路由重读、价格必填门禁和单 Pi 管理入口等缺陷；最新全量与各批次证据见 [Review 报告](2026-11-10-metawork-full-code-review-report.md)。Manager/Router 最终语义契约、Codex/金额残留删除、新 schema/命名清扫及完整任务发布仍未整体验收。当前只保留本地，不提交、不推送。

下文 B0.2 与 P1 的原始步骤记录设计依赖及故障分析方法；已关闭的历史进入条件不重复要求审批。实施以已接受 ADR、目标重置方案、续作记录和最新 Review 状态为准。

## 2. 阶段依赖与批次总览

```text
B0.2 失败逐项判定与测试基线收敛 ───────┐
                                         ├─> Phase 2 Pi 运行时收敛 ──┐
Phase 1 ADR-0055 评审与 P-1..P-4 决策 ──┴───────────────────────────┼─> Phase 3 Router / Runtime / Permission 替代与 Kernel 删除
                                                                    │
Phase 0 审计 ──────────────────────────────────────────────────────┼─> Phase 4 Token 用量与额度
                                                                    ├─> Phase 5 客户端 / Server 网络
                                                                    └─> Phase 6 剩余清扫（逐项等待替代门）
Phase 2–6 功能门全部通过 ────────────────────────────────────────────> Phase 7 发布验收
```

Phase 1 的设计门已由 ADR 接受及 Owner 豁免关闭；后续实现遵循其已接受职责契约。Phase 4、5 的局部独立功能可经 Owner 核准后与 Phase 3 并行，但不得提前删除其旧数据或旧客户端路径。Phase 6 是剩余清扫归集，不是提前进行全仓删除的理由。

| 批次 | 目标 | 主要产物 | 进入条件 |
| --- | --- | --- | --- |
| B0.2 | 将 44 项红测逐项定性并修复/改写，保住当前产品契约 | 失败判定表、修复记录、迁移后的 Workspace E2E fixtures | B0.1 记录已完成；失败列表复现 |
| P1-A | 接受无 Kernel 职责与产品策略契约 | ADR-0055 Accepted、P-1..P-4 决策、ADR/当前文档改动集 | 产品、安全、Runtime、Pi、客户端 Owner 评审 |
| P2-A | 证明 pinned upstream Pi 包可承载 Manager 与一个 Executor 路径 | 上游版本/许可证/扩展清单、隔离进程和 RPC spike | Pi 版本及支持边界确认 |
| P2-B | 将 Manager 切换到打包 Pi，保留边界与 Planner 数据契约 | Manager host bridge、只读测试、干净安装验收 | P2-A 通过，P1-A 接受 |
| P2-C | Executor 切换至同版本 Pi，逐项移除 Codex 和 vendored runtime | 唯一 Agent runtime、工具/权限/打包收敛 | P2-B 与逐 Executor 等价验收通过 |
| P3-A | 建立 Task Runtime admission/lifecycle/route 决策持久端口 | owner ports、schema 新模型、RouteDecision trace | P1-A 接受、P2 可用 |
| P3-B | Router 直派 | Router 端口、RouteDecision 持久化、no-candidate 阻塞 | P3-A；P-1 决策关闭 |
| P3-C | Manager 权限判断闭环 | PermissionService、用户升级链路、Host 边界复核 | P3-A；P-2 决策关闭 |
| P3-D | 替换恢复/完成/发布边界并拆除 Kernel | 新鲜 schema、无 Kernel 路径、E2E | B0.2 + P3-A/B/C 验收，P-3 关闭 |
| P4-A | 每模型调用完整 Token usage | Metering event、持久记录、聚合查询 | usage 来源清单、调用点盘点 |
| P4-B | Provider 分类、周期额度与用量页面 API | Included/On-demand 额度读模型与规则 | 产品 quota 数值/周期口径决定 |
| P4-C | 移除模型金额账务 | billing 价格/成本删除及专门验证 | P4-A/B 对账通过，官方付款边界复核 |
| P5-A | Server 可配置 bind / origins / client URL | Server 配置与安全验收 | 网络威胁模型与配置名确认 |
| P5-B | Web / Desktop / Feishu 用量、记忆和任务能力对齐 | 客户端 view/query/export/trace | P3/P4 API 契约稳定 |
| P5-C | 删除 TUI 产品入口、限制 Desktop/Server 发布矩阵 | CLI/Web 启动契约与 release manifest | Web 完备；替代路径验收 |
| P6 | 删除余下本地 Docker、兼容迁移链和陈旧文档；Windows 保留不维护 | 逐项移除记录及干净目录清单 | 各替代 owner gate 通过、SQLite 原生可测 |
| P7 | macOS arm64 + Web 全量与旅程验收；Linux/其他客户端延期 | 最终 acceptance report、计划关闭信息 | P0–P6 exit gates 全通过 |

## 3. B0.2：基线失败判定与 Workspace harness 迁移

### 3.1 目标与范围

本节保留 B0.2 的历史排障步骤，当前进展见 §1.2。它不是单纯重写断言，也不允许为绿测放宽 Workspace intent、安全边界、publication 完成条件或当前失败语义。先按基线实施记录的 44 项清单逐项复现，记录“实际行为、预期契约、Owner、处置、验证证据”；再实现缺陷修复或契约测试改写。

首先处理约 39 个涉及 `conversation_git` 和旧 `in_place` 假设的测试组：

- `tests/e2e/declared-file-delivery.test.ts`
- `tests/e2e/planner-owned-workspace-mode.test.ts`
- `tests/e2e/task-result-service-acceptance.test.ts`
- `tests/e2e/task-state-recovery-journeys.test.ts`
- `tests/e2e/publication-delivery-recovery.test.ts`
- `tests/session/planning-kernel-path.test.ts`
- `tests/session/scripted-session.test.ts`
- `tests/session/planning-agent-session-routing.test.ts`
- `tests/session/blocked-task-user-journey.test.ts`
- `tests/e2e/independent-branch-failure.test.ts`

以及其余失败组：span recovery、Kernel retry loop、account startup recovery、Web conversation view。对基线记录中列出的 `.metawork-tmp` 外泄、`uncertain` 外部效果、`port_in_use` 归因消失、accepted operation key 缺失、任务停留在 queued/merge 前、恢复缺 publication 等现象，默认作为缺陷候选，必须由相应 Owner 逐条给结论。

### 3.2 Harness 目标拓扑

E2E fixture 需要运行真实 Conversation Git 生命周期，mock 边界只放在外部模型/进程，不 mock seal/merge/publication 的核心协议：

1. 每个测试建立临时用户 Workspace Git 仓库，提交稳定初始 commit，并创建有唯一 ID 的 Conversation Worktree。
2. 通过真实 admission 将 Task 绑定 `conversation_git`，验证 Executor execution root 是该 Conversation 的 Worktree，而不是用户根目录。
3. 完成 attempt 后调用生产的 change capture/seal 流程，形成不可变 change record；无文件变更的报告路径应不产生 merge job。
4. 启动真实 Workspace FIFO merge worker；fixture 可注入确定性的时钟、故障点和文件内容，但不能直接预写用户 Workspace 或伪造“已合并”行。
5. 等待 publication delivery 终态，再断言用户目录可见内容、publication 状态、声明输出、Artifact/Result 关联及 Task 完成顺序。
6. teardown 先 drain worker、释放 leases，再移除 worktree 和临时仓库；失败时保留可诊断日志，不能清理掉根因证据。

### 3.3 必要测试契约

- 写入必须先在 Conversation Worktree 可见；只有 seal + FIFO merge + delivery 成功后才对用户目录可见并允许依赖节点/最终完成。
- 只读报告可并发共享读；写者对同一 Workspace 独占。跨 Workspace 不互相争用。
- `.metawork-tmp`、临时执行痕迹、未声明文件不得作为用户交付物泄漏。
- 声明文件缺失时结果不认证；用户接受结果的幂等键、接受事实和重启恢复必须按当前 completion 契约验证。
- merge 失败、delivery 失败、进程退出和重启恢复分别注入；验证是否重试的是 merge/delivery 而非重复 Executor side effect。
- 对 `uncertain` 外部效果不自动重放。恢复必须持有原 operation identity；过期/重复操作不可造成二次副作用。
- 旧 `in_place` 只允许在被明确标注的历史记录迁移/读取测试中出现，新 Task 必须断言 `conversation_git`。

### 3.4 剩余失败的归类流程与验收

每项失败至少记录：测试名、复现命令、失败栈/实际事实、保护的不变量、当前权威文档、Owner、处置（fix / contract rewrite / test bug）、变更文件、通过证据。不得仅以“将在 Phase N 重写”作为关闭状态。

退出门：44 项全部有 Owner 和定论；所有判为缺陷项已修复；所有契约变更有现行 ADR/当前文档依据和新的行为断言；B0.2 触及的完整测试组通过；全量 suite 没有未分类红测；lint/build 通过。若仍有未完成项，Phase 0 保持开放，不能开启 Phase 3 删除工作。

## 4. Phase 1：目标架构与契约接受

本阶段的契约评审必须形成以下接受条件与后续落地切面；若已有的专项设计稿不在工作区，应以本节和 ADR-0055 为评审基线补齐，不得把缺失文档视为评审已通过：

1. P-1：自动重试/Router 重新路由边界。明确 retry 是同一 route 的机械重试还是新 attempt 的重新决策、最大预算、no-candidate 行为及何时用户可见。
2. P-2：权限红线目录。产品与安全 Owner 把 capability 分类为硬拒绝、始终升级、可由 Manager 判定三类；未知 capability fail closed。不能只在 prompt 中描述。
3. P-3：部分成功呈现。规定 required/optional Subtask、认证结果、失败子任务、publication 状态对最终 Manager 汇总和客户端状态的映射。
4. P-4：Router 决策的可复核要求（**已由产品决策关闭，不再是阻塞项**）。Router 不要求
   确定性；决策必须记录实际模型、配置 revision、候选/排除快照与理由，使该次决策可审计，
   不要求相同输入复现同一输出。P-1、P-2、P-3 仍未关闭。

设计接受产物：ADR-0055 状态 Accepted；被修订 ADR 的 supersedes/amends 关系和 ADR index 一致；`CONTEXT.md`、technical overview 只在决策接受后更新；路由/权限/生命周期/schema/协议的接口 owner 与 failure owner 明确；每条 Kernel 决策映射到唯一目标 owner；P-1..P-4 无阻塞歧义。该门关闭前只允许无依赖的实验 spike，不得提交改变产品路径的实现。

## 5. Phase 2：单一上游 Pi 与 Executor 收敛

**2026-11-10 安装校验修复检查点（R-17）：** 构建来源元数据可省略 `plannerRoot`，明确提供时仍校验为非空字符串；生产配置探测识别与 Manager 相同 resolver 返回的 managed Pi 可执行普通文件，不要求存在 vendored Planner，也不以 PATH 中的全局 Pi 替代产物。无 fork 安装与错误产物回归通过；wrapper 使用 fixture，不替代干净机器真实任务验收。后续 R-18/R-20 已将 Desktop/native/release/setup、安装与签名 payload 切换为可搬移 pinned upstream Pi，移除旧 fork 构建/必需产物，生产就绪仅接受 managed Pi；source 默认只生成 Pi engineering/research。CI 使用 `tools/pi-runtime` 精确锁文件构建独立 host。实际 Manager RPC/权限与 Executor 进程已通过本地 SSE fixture 验证，归档/安装/篡改回归通过；完整 Task、Codex 全仓删除、签名干净安装仍需独立验收；Linux 按 D14 延期。

### 5.1 P2-A 上游包与隔离集成 Spike

- 锁定上游 Pi 精确版本与 package integrity；验证 Node 22.19+、macOS arm64、Linux 的安装/运行矩阵；保存许可证、NOTICE、上游 commit/tag 和依赖树证据。
- 通过 MetaWork 自己的 package manager 将同一 pinned Pi 包随产品安装。MetaWork 不调用 PATH 上的全局 `pi`，不继承用户的 Pi 配置、session、extension 或 auth 配置。
- 构建独立 Manager host process + RPC 的最小链路。RPC 必须有 protocol version、request ID、超时/取消语义、大小上限、结构化错误；子进程使用专属 HOME、配置目录和 session 根。
- 验证平台扩展装配、工具注册、event stream、完整 Token usage 回调、stop/kill 和异常退出。Spike 不做 Kernel/Manager 大范围删除。
- 对 extension API 不兼容项建立逐项差异清单，不在 MetaWork 自建 Pi fork 中补丁绕过；必须由平台 adapter/extension 承载或明确阻塞。

### 5.2 P2-B Manager 迁移

- 建立 `ManagerHostPort`/`ManagerProcessRunner` adapter；输入只包含本 Turn 的有界上下文、routing/catalog 信息、workspace read-only 摘要、任务控制事实和必要 memory ContextRef。
- Manager RPC 输出经现有规划 schema/Work Graph validator 校验。Manager 不能携带 Agent/model route 字段；不能直接访问 SQLite、Workspace 写 API、Executor 进程、Host secrets 或 PermissionService apply API。
- 迁移原 Manager 扩展：Planner tools 变为 Manager tools，并实现只读、路径 containment、请求预算、超时及拒绝写入测试。安全不能依赖 system prompt 声明。
- 保留 AnyFusion-Pi 只作为归属明确的开源上游身份或兼容合同；确认不再有运行时引用后才移除 vendored 私有 Agent runtime。产品角色字段和 UI 名称统一改成 Manager，但上游 repo/path 与必要的内部 `METACLAW_*` 合同按 ADR 逐项处理。
- 验收：空白系统未安装 Pi，MetaWork 自带包可完成一次真实规划；用户系统 Pi 安装、版本变化或配置污染不影响行为；RPC 异常可恢复并有明确失败；越权写入被宿主拒绝。

**2026-11-10 生命周期与路由修复（R-19/R-23）：** TaskControlWorkflow 区分 queued/applying/applied/uncertain；apply 前失败允许重试，并发等待共享 drain，不确定应用保留 fence；空 drain 结束时的新事件不会提前返回。Account Router 的落库回调改为真正同步重读 owner，在 append 事务内检测 Task 取消/删除、generation/graph/configuration/candidates 变化；空候选不回退旧绑定。ADR 对 D6 facade 的边界已统一，不等于最终 Manager/Router schema/资格收敛完成。

### 5.3 P2-C Executor 迁移与 Codex 删除

- 建立单一 `ExecutorRuntimePort`，由 Runtime 传入已授权 Attempt identity、Workspace root、能力 profile 和运行资源；不把 Planner/Kernel policy 复制进 Pi extension。
- Executor Pi 与 Manager 使用同一版本和独立进程/session/config 根。Pi 工具注册来自平台支持扩展；正常 Attempt 不以 affordance 派生全局 tool allowlist，affordance 只控制扩展材料化；仅 response-only correction 可采用无工具/无 session 的缩减入口。
- 对每个内置 Codex 路径做能力映射：一般代码、命令、文件、web、PDF、image、result reference、stall handling。能力无替代时保留其专用 adapter 或明确取消，不得静默丢工作流。
- 确认 Pi RPC 执行、permissions、abort、usage、tool error 与 Attempt terminal receipt 后，再删除 Codex binding、discovery、configuration、permissions、UI 和 tests/assets。删除按审计 A-E1 清单提交，不一次性 regex 删除全仓字符串。
- 验收：Pi 是唯一通用执行器；干净安装无需用户 Pi/Codex；完整工具面回归；Host 边界独立于 prompt；本轮 native macOS arm64 + Web task E2E 通过；Linux 延期。

## 6. Phase 3：Router 直派、Manager 权限与 Kernel 删除

### 6.1 P3-A Task Runtime 所有权与持久事实

先新建/收敛命名端口，不先删 Kernel：

- `TaskAdmissionPort`：校验 Work Graph、conversation slot、workspace binding 和配置 revision；一次事务写入 Task、Subtask、graph revision 和 admission identity。
- `TaskLifecyclePort`：单一状态迁移入口，检查生命周期合法性与 `state_version`；Manager/Router/Executor 均无直接 storage mutation。
- `RouteDispatchPort`：输入 ready Subtask、candidate snapshot、generation/graph revision；调用 Router 得 decision，持久化后原子 claim/launch。
- `AttemptLifecyclePort`：attempt identity、lease、heartbeat、receipt 和 terminalization；外部效果状态 unknown 时落 recovery item，不猜测。
- `PublicationPort` / `RecoveryPort` / `CancellationPort`：沿用现有 publication 和操作身份，逐项从 Kernel effect orchestration 搬到 Runtime 应用服务。
- 持久事实至少含 Task/Subtask/Attempt 现状、graph revision、RouteDecision、permission request/decision、result certification、workspace change/publication/delivery、usage reference、idempotency identities。为每项注明 repository owner、唯一写事务和重启重建规则。

新增的 domain port 由其消费者模块拥有；SQLite adapter 只实现 port。Session/Gateway 只调用应用 facade，不直接依赖具体 repository。保持 ADR-0020 依赖方向。

### 6.2 P3-B Router 决策和直接派发

`RouteRequest` 固定包含 `taskId/generationId/subtaskId/graphRevision/attemptOrdinal`、Subtask goal 与 acceptance、配置 revision、候选 AgentClass、模型 catalog、硬资格过滤事实。Router 执行：硬资格排除 → 构造有界 decision-model 输入 → 单次决策 → 输出 `RouteDecision` 或 `no_candidate`。不要求确定性，但同一返回事实一经持久化不得被后续读路径重新求值。

`RouteDecision` 记录唯一 ID、输入快照 hash/引用、候选及排除原因、selected Agent/model、decision model 身份、理由、revision 和 createdAt。Router 的纯/隔离 port 不导入 storage 或 process adapter。Runtime 收到 decision 后验证当前 generation/revision 仍匹配；原子写 route fact 并 claim；只有成功 claim 的 Attempt 启动。过期决策拒绝并重新请求 Router；同一 identity 重试必须幂等。

`no_candidate` 显式阻塞对应 Subtask，释放 claim/lease，给 Manager 可汇总的结构化事实。重试或 fallback 只按 P-1；不得静默选择 default、循环问 Router 或让 Manager 代派。

测试至少覆盖：不合格候选绝不调用/入选；模型输出非法、未知 Agent/model、超时/进程退出；配置 revision 改变；并发 claim；重复 RouteDecision；no-candidate；trace 中候选、排除和理由完整；Router 不能写状态或启动进程。

### 6.3 P3-C Manager 权限判断闭环

按三层实施：

1. Executor 发精确 capability request；Permission Service 校验 account/workspace/conversation/task/generation/subtask/attempt/request revision、partition、operation、scope、limits、profile/config revision 和进程身份，规范化并算 fingerprint。
2. Permission Service 先应用 hard-deny 和 always-escalate catalogue。hard-deny 记录 policy deny 且不调用 Manager；always-escalate 建用户 pending request。
3. 其余请求才送 Manager `judgePermission(request, boundedUserIntent, taskGoal, existingDecisions, permissionProfile)`。不得向 Manager提供密钥正文或其他 Task 数据。
4. Manager 返回 grant/deny/escalate + reason；schema 与 runtime policy 检查 grant scope 小于等于请求，不能修改 capability/partition/expiry/limits。模糊、缺上下文、模型失败、未知输出统一 escalate 或 fail closed。
5. Permission Service 以 request ID + revision CAS 写 append-only decision 并幂等应用；Executor 只收到精确 request 对应结果；Host 继续执行真实边界。
6. 用户 escalation 复用已认证客户端流程；事件绑定 request ID/revision，过期/重复/并发答复拒绝并给出当前状态。重启恢复 pending，不自动批准；授权应用不确定时保持 closed 并产生人工恢复事实。

测试覆盖硬拒绝不可被 Manager/user 盖过、always-escalate 不过 Manager、作用域缩窄、fingerprint 变更、账户/Task 交叉访问拒绝、重复/并发/过期决定、Manager 退出/重启、授权 apply 中断、Web/Desktop/Feishu 投影一致。任何模型结果都不得替代 Host denial test。

### 6.4 P3-D 恢复、完成、发布替代及 Kernel 移除

- 把 Kernel event/snapshot 中非决策的机械事实逐类迁至其 owner service：claim/lease、attempt receipt、cancel、publication、outbox、startup reconciliation。决策动作不可原样挪进“Coordinator”；按职责矩阵拆到 Runtime、Router、Manager、Permission Service、Host 或删除。
- 所有 effect 使用明确 operation identity、状态机和唯一应用路径；恢复只重试可证明幂等的 effect。无法判断外部 side effect 是否完成则记录 `unknown`/recovery item 并 fail closed。
- Task 完成门禁按三类事实分别推进，不能压成一个“Subtask done”：
  1. Attempt receipt/certification（一次执行的终态与认证）；
  2. Subtask dependency-ready（下游依赖所需 handoff/result reference 已 materialize，与上游
     done 同事务）；
  3. Task user-delivered（seal → Workspace FIFO merge → delivery facts → Manager summary）。
  先 receipt、再 dependency-ready、最后 Task 交付；任一阶段失败只阻塞该阶段，不得先用
  done 标签再补 handoff。可交付的部分结果及失败展示按 P-3。
- 先关闭所有 owner-level 新路径测试和 B0.2 E2E，再按独立提交拆除 Kernel decision interface、workflow ledger/replay、Kernel event/snapshot/status projection、Kernel-specific config/callers/tests/tables。同步移除 span advisor 的时候 Router trace 和替代测试必须已通过。
- fresh schema 初始化先保留全部新 owner 必要事实；删的是 Kernel 决策账本和过时兼容表，不删 Task/Attempt/result/publication/permission/usage 等事实。

分批删除顺序建议：a) 无调用的 Kernel projection/UI；b) 已替换的 Kernel event producer/consumer；c) DurableKernelWorkflow 与 ledger；d) Kernel schema、迁移读取器和旧 tests；e) span advisor/第二策略路径。每批前 `rg` 引用盘点、构建、边界测试；每批后全量 tests 与 `rg` 复查。

验收：生产和测试均无 Kernel 决策 API/ledger/replay；没有名为 coordinator 的中央策略循环；Task restart、permission pending/apply、Attempt cancellation、publication retry、completion acceptance 的真实 E2E 都通过；旧 DB 按明示策略拒绝，而不是被 Kernel reader 重新打开。

## 7. Phase 4：Token 用量与额度

### 7.1 P4-A 调用点盘点与 per-call usage fact

先列出所有模型调用入口：Manager 规划/重规划/权限判断/汇总，Router 决策，Executor 每轮模型调用，response-only correction，官方托管 AI，以及任何后台模型能力。每个入口说明 provider/model/source、payer category 来源、时间、usage 回调与失败行为。没有 provider 返回 usage 时，处理方式必须由支持矩阵决定，而不是产品内的一个“不确定用量”
状态：
- provider 明确提供 usage → 记录精确整数；
- provider 支持但本次缺失（异常/取消）→ 记录 `usage_source='provider_unavailable'` 且
  tokens 为 NULL，并把该调用标记为计量缺陷进入告警与对账清单；**不得**记为 0 或估算值；
- provider 不支持 usage → 该 model 不可进入受支持矩阵（调用前 fail closed），或在适配层
  用 provider 官方计数接口取得真实值。
因此 `ModelUsageFact` 的 token 列允许 NULL，但受支持调用的 NULL 是违约事实，不是业务状态。

统一 `ModelUsageFact` 最小字段：`usageId`、`callIdempotencyKey`、`accountId`、可空的 `conversationId/taskId/subtaskId/attemptId`（按真实调用归属）、`source`、`providerId`、`modelId`、`payerCategory(included|on_demand)`、`inputTokens`、`outputTokens`、可用的细分 token 字段、`totalTokens`、provider response identity、`occurredAtUtc`、`recordedAtUtc`、usage source/version。用整数非负数和一致性约束保存；重复 callback 由 call key 唯一约束去重。不得保存 unit price、currency、cost amount 或 amount status。

落点建议为 `src/metering` domain service + owner-owned repository port + storage adapter。API 只接收已经规范化的 provider usage；事务写 per-call fact 和聚合 outbox。不存在 task 的 Router/Manager call 仍可归属 Account/Conversation 和 source，不能丢弃。观测缺失须作为契约违反和可见告警/调用失败处理，而非“unknown token usage”业务状态。

### 7.2 P4-B 聚合、Provider 分类和免费额度

- 将 `Included`/`On-demand` 归属在调用发出前的 provider binding/payer snapshot 上，不能按当前配置回写历史记录。
- 以 `Asia/Shanghai` 作为面向用户的日期边界；底层事件时间存 UTC。区间包含规则统一为 `[from, to)`，服务端负责转换北京时间自然日，避免客户端各算一遍。
- 聚合 API 返回区间总 Token、Included、On-demand、按日堆叠数据、模型明细、Provider 分组；同一 usage fact 在各分组维度之和必须可对账。
- quota service 按账户/provider/周期聚合 Included Token；额度到达阈值不硬停任务，产生 exhaustion guidance 和供应商目录入口。不得将用户自备 Provider 用量扣到 Included quota。
- 配额阈值、免费基线、周期起点等数值/口径是产品输入。未决前不硬编码正式档位、不进入完成验收；可用测试配置验证计量管道。

**2026-11-10 本地交付检查点（R-08～R-10）：** 新增认证的 `GET /api/usage/timeline`，账户由 Server 绑定，只接受 period/groupBy/start/end 单值参数。Web “账单”页已切换为账号级 Token 用量，不要求选中会话；今日/本周/近 7 天/近 30 天/本月/上月/订阅周期/自定义、三张总量卡、按天堆叠柱、模型图例切换、Provider/Model 分组和每日明细已实现。区间以北京时间自然日转换为 UTC 半开范围，最多 366 天；订阅周期直接复用 quota window，包含非整日试用周期。BigInt 保持整数精度，缓存/推理子集不重复相加，system 用量排除，unknown 归属和计量缺失明确披露。Manager 与 Executor 的 Pi 适配器先将原始 input + cacheRead + cacheWrite 归一成完整输入量，显式错误缓存计数使输入缺失；不自动重算历史事实。quota guidance 与 Manager preflight 共用账号全部官方角色聚合，自备 Provider 不扣 Included。对话和轨迹已停止展示/轮询逐 Turn 金额账单。当前按 capturedAt 读取既有事实；完整调用点覆盖、occurredAt/version/source 等目标字段、数据库聚合与大数据量性能、正式额度档位和供应商目录仍未闭环，§7.3 金额链删除仍未完成。验收证据见 review 报告与续作记录，不以此宣称 Phase 4 全部完成。

**2026-11-10 归属修复检查点（R-14/R-16）：** Manager 规划、权限判断与 Executor 的观测/执行 Span 按调用固定配置版本解析 Provider 所有权，热更新不改变未完成调用的 payer。找不到固定版本或 Provider 时记录 unknown，不回退活动配置或部署默认 payer。恢复/权限读取历史版本进入同一个 runtime snapshot cache，版本不匹配拒绝加载，不切换活动版本。Manager preflight 复用实际模型选择，只对官方 Provider 读取 Included，并在每次检查清除过期提示。R-21 将尚未选择模型的准入占位 Span 改为 unknown；R-24 将 Task/Provider/model 一并固定在调用幂等身份内，防止不同调用数据混入已有归属。R-22 时间线/额度改用 SQLite iterator，十万行回归验证精确整数、分组与账号隔离，避免一次物化全部事实；仍需生产延迟验证和数据库分组聚合评估。上述批次不关闭旧金额链、所有后台调用计量覆盖或发布包验收。

### 7.3 P4-C 账务分离与移除

确认商业订阅/License/支付仍由 official-server 负责；只移除模型单价、货币换算、cost entry、per-task bill、usage settlement、金额待确认等模型费用路径。改造时先并行产出新 usage read API 与客户端投影，再删除旧接口、表和配置；不要删除产品订阅付款。

迁移策略遵守 fresh schema 约束：不升级或搬运旧 cost rows。若需保留历史展示，必须由产品明确；当前目标是删除历史兼容路径，不把金额旧值转换成 Token。SQLite 新 schema 创建表清单不含旧 billing price/cost 表；账户 License/支付 schema 由官方服务独立保持。

验收：每个受支持模型调用与 provider response 可对账；重复事件不重复累计；按北京时间聚合与逐行之和一致；Included/On-demand 分类稳定；无价格配置/金额账单/待确认 UI/API/表；quota exhausted 只引导，不阻断 Task。

## 8. Phase 5：客户端能力与 Server 地址

### 8.1 P5-A Server 监听和来源策略

- 在 Server config 增加 bind host/address 与 allowed origins；默认保持 loopback，以保护现有本机安装行为。支持 loopback、wildcard 和显式 IP；启动时解析/校验地址并在 status/doctor 中展示实际监听范围。
- 监听非 loopback 时仍强制现有认证、Account 授权和 CSRF/Origin 校验；CORS allowlist 只决定 browser origin，不能代替 authentication。wildcard bind + 空 origins 不应暗中成为浏览器可访问配置；按既有安全模型拒绝或显式禁用 browser surface。
- 内部 IPC、Planner/Manager bridge、memory sidecar、official local service 和其他仅本机端点始终绑定 loopback/Unix socket；不能继承公开 bind host。
- 同源 Web 访问按真实 Host/Origin 处理； allowed-origin 比对 canonical scheme/host/port，拒绝 wildcard credentials 和 `null` origin，避免 DNS rebinding/反射来源。
- 客户端连接 URL 来自可配置 Server endpoint，不假设 localhost。Web/Desktop/Feishu 继续使用同一认证 principal 与 account isolation。

测试：loopback 默认兼容；指定 IPv4/IPv6 地址监听；非回环请求未登录拒绝；认证错误/越权拒绝；allowed origin 正反例；Host/Origin 不同源攻击、凭据 CORS、内部端口不可由网卡访问；endpoint 配置切换后客户端重连；status 隐去 secrets。

### 8.2 P5-B Web / Desktop / Feishu 能力收敛

- 先以 Gateway/API 契约定义 Task、permission pending/resolution、trace、usage、memory 的跨客户端数据形状和分页游标；客户端只做投影，不另写状态判断。执行状态与现有 TaskView userState 对齐。
- Usage 页面：独立账单/用量 Tab，区间选择、Total/Included/On-demand 三卡、按日堆叠图、模型 legend toggle、Provider/Model group-by。只呈现 Token，不呈现金额和价格。
- Memory 页面：独立 Tab，服务端分页、搜索/筛选、完整正文授权读取、导出。导出必须 Account 范围校验、分页/字节上限、稳定格式版本和取消/错误处理；2026-11-10 用户确认导出为版本化 JSON：当前账号全部受管理 L1/L2/L3 启用/停用资产的完整正文与元数据，不包含 L0 对话原文或凭据；单次 10,000 条 / 32 MiB，非事务快照，详见 ADR-0049 的管理导出补充与全盘 review 报告。
- Router trace 展示 Agent/model、决策理由、排除候选；permission trace 显示请求范围、Manager grant/deny/escalate 或用户答复及 applied 状态，但不显示 secret。
- Web/Desktop/Feishu 共用契约；本轮只验收 Web，其余客户端按 D14 延期，不能自行改变服务端语义。

### 8.3 P5-C CLI、Desktop 与产品形态收敛

- `metawork` 无参数入口打开本地/配置 Web URL；Server lifecycle/diagnostic 命令保留。删除 `metawork tui`、Ink UI、TUI-only 参数、入口及脚本前，确认所含能力均已由 Web/Desktop/Feishu 提供并有用户旅程测试。
- `METAWORK_*` 为产品配置环境变量；产品角色 UI 为 Manager/Router/Executor。D6 已删除 vendored fork；上游 attribution 保留。D7 命名清扫须按明确清单执行，不在局部修复中无差别 rename。
- Desktop 目标为 macOS Apple Silicon但本轮验收延期；Linux 部署由运维方负责。Windows 按 D13 保留代码、停止维护和发布，不能把删除 Windows 运行时作为门禁。
- bare CLI 行为、`server start/stop/status/doctor`、Desktop deep link、本机 Server 启动/重连各自有独立 acceptance。去除客户端并不改变 Gateway/AccountRuntime ownership。

## 9. Phase 6：剩余兼容、Docker、Windows 与文档清理

本阶段每个清理对象必须来自审计 ID，不接受“顺手重构”。每项提交记下旧入口及所有生产引用、替代 owner/替代测试、持久数据影响、删除理由、rollback commit。

建议清理顺序：

1. 完成 phase 2 后删除 vendored Pi runtime 中不再运行的 private Agent surfaces、非支持 TUI 与旧 Manager 构建入口；上游 notices/license 及必要兼容 identity 保留。
2. 完成 Phase 3 新 owner 持久事实后，删除 Kernel schema、ledger replay、旧 migration readers、旧 Kernel 状态 projection；不留历史 Kernel reader，也不动官方服务数据库。
3. 完成 Phase 4 新 usage 路径后，删除 billing/metering 中金额域代码和本地旧金额表；账户 License/订阅支付路径保留。
4. 旧 TUI/非支持 Desktop 发布目标按 D11 清理；Windows runtime/install 代码按 D13 保留不维护，停止发布。
5. 按 D12/D14，在维护中的 macOS arm64 原生验证后删除本地 Dockerfiles、Docker attempt backend、image scripts 与 Docker-only tests。生产 native reconciler 和 docker_socket 硬拒绝不是 Docker 执行路径，保留其实际职责；Linux 不作为本轮删除前置门。`official-server/Dockerfile` 与其 deployment 资产由官方服务 Owner 决定，不能被本地任务容器清理误删。
6. 最后清理过期配置 parsers、协议兼容 branch、重复 script、已完成 active plans 和过时 docs/current；文档只在代码契约已稳定后归档或修订。

fresh schema 方案：定义唯一 `CURRENT_SCHEMA_VERSION`/bootstrap schema，不再提供逐版 upgrade chain。Server 启动首先只读识别 schema marker；空库创建新 schema；匹配新版本正常打开；旧版本/未知 schema 在任何写操作前失败，错误说明备份/显式重置流程和将丢失的本地数据范围。产品不提供在本次启动中自动清库的按钮或隐式降级。官方账号和支付数据不属于本地 reset。

Docker 删除门（D12/D14）：本地 unused Docker backend/资产和专用测试删除；维护中的 macOS 原生 SQLite/execution/recovery 测试通过；生产 native reconciler 与权限硬拒绝保留。R-26 已清理本地 runtime/test 资产，container schema/catalog 等残留仍需按实际可达性处理。官方服务 Docker 独立保留。Linux 验收延期。

Windows 状态（D13）：保留代码和历史分支，不维护、不继续发布；本轮没有 Windows 删除门。

## 10. Phase 7：集成验收与发布关闭

### 10.1 自动验证矩阵

- 静态：root、web、desktop、official-server、upstream Pi 各自 lint/typecheck/build 及 license/package integrity 检查。
- 单元/模块：Work Graph、Task lifecycle、Router policy output validation、Permission hard-deny/scope、Host boundary、Metering normalization/dedup、quota aggregation、Server origin/auth。
- 集成：Gateway -> Manager RPC -> Work Graph -> Router -> Runtime dispatch -> Pi Executor -> permission request -> publication -> Manager summary -> Web/Feishu projection。
- Recovery：每个持久写入边界前后 kill process；验证重启不会丢/重复 route、Attempt、permission decision、publication 或 usage。
- OS：本轮 macOS arm64 原生运行全量 SQLite suites 与 Web；Linux/Desktop/飞书按 D14 延期，Docker 不作为验收执行器。
- 安装：干净机器无 Pi/Codex，安装产品后 Manager+Executor 同版本运行真实任务；验证用户 HOME/session 不被读写。

### 10.2 真实用户旅程验收

1. 免费额度首次使用、官方 Provider key 不出现在任何客户端、用量显示正确。
2. Included quota 达上限，任务仍可继续，出现第三方目录引导；On-demand 不扣 Included。
3. 复杂工作图由 Manager 拆解，Router 为每个 ready Subtask 决策并直派，用户 trace 可读，最终由 Manager 汇总。
4. 常规权限由 Manager 自动判断；无足够意图上下文时升级用户；hard deny 无法由 Manager/用户模型决策绕过。
5. Executor 产出文件，经 Worktree seal/FIFO merge/delivery 后可见；publication 失败恢复不重复执行原 Attempt。
6. 本轮 Web 对权限、Task、trace、usage 和 memory 提供规定能力；Desktop/飞书旅程按 D14 延期。
7. Server 绑定非回环接口时经过认证与授权；不允许 origin 和内部服务对外访问均被拒绝。
8. 老本地 DB 启动被明确拒绝，不自动迁移/删除；官方 License/payment authority 不受本地重置影响。

### 10.3 最终关闭信息

更新总计划：状态、完成日期、实现批次/commit、最终交付行为、macOS arm64 命令与版本及 Linux/其他客户端延期范围、每个 acceptance 结果、明确 deferred criteria、已归档文档位置。任何剩余 skipped/失败项都必须有名称、理由、owner 和不会依赖被删兼容路径的说明；不以“已知 CI 遗留”替代 exit gate。

## 11. 全批次工程模板

每个后续实施批次在开始编码前复制本表到对应实施记录：

| 项 | 必填内容 |
| --- | --- |
| Scope / owner | PRD 条款、审计 ID、唯一模块 Owner、明确不涉及的边界 |
| Before | HEAD、工作树状态、相关 schema/config/protocol 版本、基线命令与结果 |
| Contracts | 输入/输出、状态转换、错误/超时、幂等键、权限边界、唯一写入者 |
| Data | 表/字段/索引、事务边界、重启恢复、fresh schema 行为、不可迁移数据说明 |
| Sequence | 可独立 review/rollback 的提交次序；替代先于删除；临时并存的截止批次 |
| Tests | Owner unit、模块 contract、failure injection、e2e、macOS/Linux 验证及真实旅程 |
| Exit | 可量化通过条件、阻塞项、不得推进的下游阶段 |
| Close | 变更摘要、实际命令/环境/结果、commit、回滚点、文档/索引状态 |

不接受“已实现”但没有实际运行证据的测试，不接受只改测试预期而没有契约来源的红测关闭，也不接受跨阶段一次性删除无法独立回滚的批次。

## 12. 与现有计划的关系

- Phase 0 审计范围以收敛实施计划中的覆盖与退出门为准；当前方案内的 B0.2 记录必须承接失败明细、Owner 判定和验证证据。若审计报告/基线记录作为独立文档重新加入工作区，应与本方案状态保持一致。
- Phase 1 的职责、权限、Router、持久事实/schema 与评审表以 [ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md) 和本方案第 4、6 节为准。ADR 已接受且 Owner 明确豁免交叉评审；本方案不虚构签字或重复建立审批门。
- 上位计划中的云端部署环境、数值 quota、memory export 细节等 Deferred Decisions 继续是独立产品决策；方案不得自行补产品政策。

## 13. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-07 | 初稿：细化 Phase 0–7、当前 B0.2 门槛及 Router/Permission/Runtime/Usage/Client/cleanup 的批次技术路线。 |
