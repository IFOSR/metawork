# Span 路由增强设计

- 日期：2026-09-27
- 状态：已实现（2026-09-27）。范围、架构、事件持久化与凭据方式已由用户确认。
- 基线：`main@55184d84f848af4909508717199c8c3dd43f7739`
- 工作分支：`feat/span-routing`
- 实施计划：[Span routing implementation](2026-09-27-span-routing-implementation-plan.md)

## 1. 目标与范围

在 MetaWork 已有合法 AgentClass + Model 候选中，用 `respan/span-01-lite` 的 `noul` 判断辅助排序。Planner 提案、Kernel 授权、Runtime 应用、Executor 执行的权责不变。Span 不生成工作图、不创建授权 binding、不执行任务。

本期只做 Span：不引入通用 RoutingAdvisor 接口、模型注册表、Jev 适配、choice/score、多模型切换、shadow 调用、自动学习或 Span 到其他外部模型的失败切换。外部服务失败只恢复现有确定性 AutoModelResolver。

用户在现有高级设置中填写 OpenRouter API key，复用 Provider 的 SecretStore、凭据状态和配置激活/回滚机制。无需添加 Provider、Model 或 Executor 来配置 Span。

## 2. 代码证据与边界修正

基线代码中 `AutoModelResolver.resolve` 同时过滤和排序；`resolveAuthorizedBindings` 在 `control-kernel.ts` 中按 Planner 提议的 AgentClass 分别解析模型，最后形成每个 Subtask 的 binding 顺序。AgentClass 健康检查目前在模型解析之后执行。`projectConfigurationCandidates` 将模型健康初始化为 healthy，不代表已接入实时 Provider/Model 探测。因此实施不能宣称当前已有全部实时健康、容量或准确成本数据。

需要提取共用纯函数：模型合法性与确定性排序归 routing；健康策略仍归 Kernel，应用层只消费 Kernel 给出的合格事实。请求前和最终授权时必须使用同一规则，不能复制一套较宽松的 Span 过滤逻辑。既有成本/延迟估算缺少元数据时的处理保持原规则；本期不把估计值升级成真实预算保证。

固定模型 policy 仍固定；候选 AgentClass 限于本次 Planner proposal 中已有且合格的定义，不能自动扩展至整个 catalog。Runtime 动态容量与资源冲突仍由最终 admission/dispatch 检查，Span 不预留容量、不授予权限。

## 3. 唯一职责与依赖方向

| 所有者 | 本次职责 |
| --- | --- |
| Configuration | Span 配置校验、不可变 revision、安全投影、凭据读写与激活回滚 |
| routing 纯模块 | Span observation 值类型、候选 identity、共用过滤/排序、响应契约校验 |
| Span 外部适配器 | 唯一 SDK 调用、请求构建、限时和外部响应规范化 |
| Application Shell | 验证后、事件入库前编排 Span，复用持久事件，处理取消和并发 |
| ControlKernel | 最终硬校验、observation 适用性检查、binding 及 fallback 顺序授权 |
| Storage | 原有 kernel_events 和 decision ledger 保存事件/快照/决策 |
| Settings UI | 编辑开关/key、显示凭据状态和服务端结果 |

Kernel 不导入 SDK、SecretStore、网络适配器或具体 Repository。外部适配器可物理放在 `src/routing/span-routing-advisor.ts`，但不从 Kernel 使用的 barrel 导出它，纯类型/规则文件不能反向依赖适配器。Session 只编排，不自行裁决候选合法性。没有临时第二语义路由入口。

## 4. 配置与用户操作

新增可选配置 `routing.span`；旧 revision 不含此字段时视为禁用，不重写历史内容或 hash：

```ts
interface SpanRoutingConfiguration {
  enabled: boolean;
  model: 'respan/span-01-lite';
  apiKeyRef?: string;
  timeoutMs: number;
}
```

默认 model 固定、enabled=false、timeoutMs=3000；timeout 允许 500–10000ms 的服务端校验范围。模型在 UI 中只读展示，无模型/provider 选择器。高级设置提供启用开关、password 类型 OpenRouter API key 输入框、已配置/未配置状态；超时可以保留服务端默认，不要求用户填写。保存空输入表示保留 key，禁用不删除 key，重新输入表示替换，成功后清空输入框。无需新增在线 probe 按钮或将网络探测作为保存成功的条件。

key 仅作为写入请求中的临时字段，不能并入 config 对象。复用 Provider 现有激活事务的 stageSecrets 和 rollback 回调，但当前 `secrets` 映射按 providerRef 解释，不能伪造 Provider 或将 Span key 塞进这个映射。新增一个有类型的 Span 凭据写入字段，服务端固定解析为专用引用（`file-secret:anyfusion/routing-span`，与 Provider 共用 SecretStore staging 工具，且同时兼容 `CredentialsFileSecretStore` 的引用格式）。客户端不能提交任意 secretRef 读取/写入目标。

revision 只保存 apiKeyRef，读取接口只显示凭据状态。引用格式不合法应拒绝配置；启用但未提供引用、或存储中 key 不可读时允许保留可选功能配置，并显示提示，运行时走 `secret_unavailable` 回退。SecretStore 写失败属于保存失败，不能假装配置已成功。

Span 变更遵循现有激活 gate 和 revision 冲突校验；“热生效”不绕过忙碌保护。配置激活失败恢复之前的 Span 与 Provider key，失败回滚进入现有 recovery-required 流程。SecretStore 的值本来不是历史 revision 的不可变副本，历史路由重放依赖 observation，而非取旧 key 重打 API。

Planner 配置投影、Executor runtime/environment、生成的 agent home 不包含 Span 配置和 key。Kernel 只取得启用/策略等必要非敏感字段，不取得 apiKeyRef。只有 Server 的 Span 适配器通过 event 指定 revision 查配置、解析 key。

## 5. 候选与排序规则

每个 Subtask 分别处理：

1. 校验 proposal、graph、revision、AgentClass、permission profile、capability、ModelPolicy、Provider/Model enablement、Harness 兼容性及已有 context/cost/latency/quality 硬限制。
2. 使用 Kernel 健康规则排除当前不可用 AgentClass；不将非合格候选发送给 Span。无候选时由原有 reject/defer 路径处理，Span 失败不能将非法请求变成合法请求。
3. 以稳定排序的候选身份生成 question ID；identity 包含 Subtask、AgentClass、Provider、Model、Harness、permission profile、configuration revision。使用规范化序列化 hash，不拼接可能歧义的分隔字符串。
4. 有零个或一个合法组合时不请求；记录 skipped 状态并保持原决策。
5. 对每个合格组合提一个 noul 问题，概率用于软排序。
6. 在同一 AgentClass 内，保留既有 preferred-capability 优先比较；随后 probability 降序，然后完整旧 resolver comparator 作为平局规则。没有有效 observation 时逐项维持旧顺序。
7. 每个 AgentClass 仍输出一个模型 binding，选中的 binding 在合法 AgentClass 之间按 probability 降序排列；平局按 Planner 原提案顺序。不能新增原来未授权的 model fallback binding，也不能放宽固定模型配置。
8. Kernel 将最终顺序写入现有 `authorizedBindingsBySubtask` 与 routing audit；Runtime 只应用它。已授权后的 retry/fallback 不重算 Span。

Span 的 noul 是独立候选适配判断，不是候选之间归一化分布，更不是已校准的任务成功率。本期不设“低概率即拒绝”、不做概率加权成本公式、不把两个不同比例的分数直接相加。使用固定输入和可审计的字典序规则，后续再根据任务结果评估质量。

## 6. 外部调用

通过 `@openrouter/sdk` 的 `openrouter.alpha.decisions.create(...)`，固定 OpenRouter 地址和 model。使用已实测版本 `1.3.32` 的准确类型，安装时锁定版本并检查其请求、timeout、retry 和 abort 配置。

state 只包含经过脱敏并限长的 Subtask 标题、目标、必需能力、验收摘要，以及合格候选的有效能力、用途提示和现有成本/延迟等级。只纳入与此 Subtask 有关的事实，不读取附件内容、仓库、完整会话或完整用户请求。任务文本视为数据，不允许它指示修改候选或权限。脱敏不等同于完全保密；启用文案应说明会向 OpenRouter 发送必要任务摘要。

每个问题必须明确引用对应候选，不能所有问题只问未指明对象的“此候选是否合适”：

```ts
{
  type: 'noul',
  instructions: 'Evaluate state.candidates.c000 against state.subtask requirements.',
  criteria: {
    true: 'The candidate is well suited to perform the described subtask.',
    false: 'The candidate is poorly suited to perform the described subtask.',
  },
}
```

每个 Subtask 一个批量请求，最多 32 个候选、32KiB 请求；整个 proposal 最多 128 个候选、16 个被评估 Subtask、128KiB observation。超限的 Subtask 回退，不截掉合法候选制造偏向；整个 observation 超限时整次回退。每个 proposal 的外部请求总截止时间为 timeoutMs，不能让 N 个 Subtask 顺序累积 N 倍超时。Server 限制最多 2 个并发 Span 请求，等待计入截止时间，无无限队列。SDK 自动重试关闭；超时发送 abort，不仅 Promise.race。取消、服务停止中断请求；迟到结果不能复活 Turn 或入库。

只接纳 exact question ID 集合、type=noul、finite 且 [0,1] 的数值。缺失/未知 ID、错误 primitive、无效模型身份均使该 Subtask 全部回退；不部分采用同一 Subtask 的回答。模型字段允许已核实的 Span snapshot 形式，并在 observation 中保存实际返回版本；usage 字段可缺省，但出现时必须有限、非负、有界。错误仅保留枚举和可选 HTTP status，不保存 SDK 原始 error body。

## 7. 有界持久 observation

`KernelEvent` 的 `plan_proposed` 增加可选 `spanRouting`，由服务端填充，不加入 Planner proposal schema：

```ts
interface SpanRoutingObservation {
  schemaVersion: 1;
  policyVersion: 'span-routing-v1';
  questionVersion: 'span-fit-v1';
  model: 'respan/span-01-lite';
  eventId: string;
  proposalFingerprint: string;
  configurationRevision: string;
  generationId: string;
  targetGraphRevision: number;
  subtasks: Array<{
    subtaskId: string;
    candidateSetFingerprint: string;
    status: 'advised' | 'fallback' | 'skipped';
    reason?: string; // 实现为有限枚举
    resolvedModel?: string;
    candidates: Array<{
      candidateId: string;
      agentClassRef: string;
      providerRef: string;
      modelRef: string;
      probability: number;
    }>;
    usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
    durationMs?: number;
  }>;
}
```

实现中使用 discriminated union：只有 advised 分支有完整概率，fallback/skipped 不允许伪造零分。成功状态、远端失败、disabled/no-choice 跳过分别记录。枚举覆盖 secret_unavailable、timeout、http_error、invalid_response、candidate_mismatch、input_too_large、budget_exhausted 等；取消走原取消机制，不作为允许执行的 fallback。

Kernel 重新计算合法集合并校验 event/proposal/revision/generation/graph/Subtask/候选 fingerprint，任一不匹配则仅废弃该 Subtask 的评分，使用当前合法集合的确定性排序。配置本身的 revision 不匹配仍按原路径拒绝，不能用 fallback 绕过。新增或消失候选均不能复用不完整评分。

`kernel_events` 原有 JSON 保存 observation，decision ledger 原有 event/snapshot/decision JSON 足够重放，不新增表。缺少 observation 的历史事件走旧算法，不修改历史数据。routing audit 记录是否采纳、采纳概率、回退原因和策略版本，且对最终选择的 binding 保持一致。

## 8. 编排、幂等和恢复

首次 proposal 在验证通过后、提交 durable inbox 前进行 Span preparation。同一 preparation 函数覆盖 initial、replan 和 conflict_replan。基线 replan 是由 Runtime apply 回调返回事件后经 `markApplied` 入库，不能只在初始 `submitKernel` 外围加钩子。

优先在 `ConversationSession` 的三个事件生成路径完成 enrichment，并由 Server 注入专用应用服务。自动恢复的 system binding 也必须装配同样依赖；不得引入活跃 Web/Conversation 连接依赖。SDK 调用不能进入同步 `buildSnapshot`、`ControlKernel.decide` 或数据库事务。已有 replan 可能在账户串行 apply 中等待 Planner，本期不扩展该调度架构，但 Span 增量等待必须受 proposal 总截止时间限制。

先通过 runtime port 查已有 event/decision，同 event 重放复用持久事实；同进程相同 submission 使用 in-flight 去重并检查 proposal fingerprint。返回后再次检查取消和配置有效性，持久化竞争以已写入事件为准，不能覆盖第一次写入的 observation。

保证边界：**事件成功入库后不再请求 Span**。若请求已到达 OpenRouter、事件入库前进程崩溃，重交可能产生重复外部请求/费用；没有已验证的远端幂等协议，不能承诺恰好一次。超时 abort 也不保证上游尚未计费。接受这个 phase-one 边界，不为此引入独立数据库表或后台请求状态机。

replan 保持已有 generation 的配置固定约束；不能因为“新 replan”就读取当前活动 revision 替换历史 revision。deferred availability 恢复不调用 Span；复用已有授权事实，不重新评分。需要检查现有 `bindingsForProposalSubtask` 重排逻辑，避免它丢失已经授权的 Span 顺序。

## 9. 验证与交付

测试必须覆盖过滤不变性、排序确定性、跨 AgentClass 顺序、固定模型、未知/缺失/非法概率、限时 abort、输入界限、密钥隔离、配置回滚、事件重复提交、三个 proposal 来源、取消、候选变化、重放零请求和 deferred recovery。SQLite JSON 新字段无 DDL migration，仍须验证仓库 round-trip 和 Docker 持久化回归。

先通过 mocked SDK + 真 SQLite 的闭环，再执行真实 Span smoke（凭据从 SecretStore 读取且不输出）。此前手工 API 实测验证 noul 与 batch 可调用，不证明本次集成或排序质量已通过。用固定任务样例对比旧 resolver 与 Span 的选择、延迟、失败率和 usage；测试阈值不能臆测为成功率。

Span usage 保存为内部路由观测，不冒充 Planner/Executor 用量或自动新增用户账单扣费。本期不扩展 billing stage/外部消费协议；若需要计费，另按 ADR-0042 定义价格与付款方。

实施时同步修订 ADR-0033（Span 只辅助排序）、ADR-0023（事件中外部观测与重放边界）、CONTEXT、技术总览与配置操作说明。实现完成前这些文件仍描述现状，不提前宣称已部署。

## 10. 完成记录

设计与计划产出日期：2026-09-27。产品实现在同一日期完成于分支 `feat/span-routing`（起点 `main@55184d84`），关闭提交见实施计划的交付记录。真实 OpenRouter 集成 smoke 需要运维提供已轮换的密钥并显式执行 `npm run smoke:span-routing`，未在本次自动化验证中运行；Docker 持久化验证同样未执行。部署尚未进行。
