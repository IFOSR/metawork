# Span Routing Implementation Plan

> 使用本仓库可用的 `executing-plans` 技能按任务执行；下列步骤是实现与验证顺序，不需要反复向用户请求已确认范围的许可。

**Goal:** 在高级设置配置 Span OpenRouter API key，对硬过滤后的 AgentClass + Model 候选进行 noul 软排序，保留确定性回退和 Kernel 授权。

**Architecture:** Span 专用适配器在 Application Shell 中、plan_proposed 入库前运行。校验后的 observation 随事件进入现有 durable inbox 和 decision ledger；Kernel 重新校验其适用性后排序，不进行网络请求。凭据复用 Provider SecretStore 和配置激活回滚。

**Tech Stack:** Node 22.19+、TypeScript ESM、@openrouter/sdk 1.3.32、Zod、better-sqlite3、Vitest、现有 React Web 设置面。

---

- 日期：2026-09-27
- 状态：代码、本地验收与真实 API 验收已完成；精确 Dockerfile 镜像构建仍受网络阻断。见[设计收尾记录](2026-09-27-span-design-closure.md)和[真实验收记录](2026-09-27-span-live-acceptance.md)。
- 设计：[Span 路由增强设计](2026-09-27-span-routing-design.md)
- 起点：`55184d84f848af4909508717199c8c3dd43f7739`
- 分支：`feat/span-routing`
- Worktree：`/Users/ylfego/Program/agents_test/collection/metawork-span-routing`
- 原工作树：`../metawork`，保留所有用户改动，不 checkout/reset/stash，不复制其未提交文件。
- 计划与产品代码收尾日期：2026-09-27；closing implementation commit：`9a4f455`（真实接口字符串 state 修正；之前收尾提交 `4190eea`）。

## 实施前固定约束

1. 只实现 Span，不创建通用 RoutingAdvisor、多 provider 注册表、Jev/choice/score、shadow 或外部模型 fallback。
2. API key 在高级设置直接输入，保存和替换与 Provider 同样使用 SecretStore；不能创建假的 Provider/Executor。
3. 固定 model=`respan/span-01-lite`；关闭默认、3 秒默认总截止时间。未启用或无 key 时保留旧路由。
4. observation 放在服务端 KernelEvent 中，不放 Planner proposal，不新增 SQLite 表。
5. 历史事件无字段时保持旧行为。重放已入库事件零 API 请求；入库前崩溃允许重复请求，不能声称恰好一次。
6. 合法候选限于 Planner 提议的 AgentClass；不扩大 permissions/model policy/Harness/capabilities。Span 的高分不能使非法候选获准。
7. 固定 policy 不换模型；每个 AgentClass 保持现有一个 binding 的输出数量。Span 可排序合法 AgentClass 的优先顺序，不增加 model fallback 列表。
8. `noul` 数值是适配信号，不设置未经校准的成功率阈值。
9. replan 沿用原有 generation revision 规则；历史任务不能自动换当前活动 revision。
10. 密钥/原始请求/原始 SDK error 不进入 observation、日志、Planner、Executor 生成环境或客户端响应。

## Task 1：配置契约、安全投影与凭据激活

**Files — 修改：**
- `src/configuration/types.ts`
- `src/configuration/schema.ts`
- `src/configuration/projections.ts`
- `src/configuration/configuration-diff.ts`
- `src/configuration/configuration-runtime-coordinator.ts`
- `src/server/server-composition.ts`
- `src/management/server.ts`
- `web/src/api/http.ts`
- `web/src/api/types.ts`

**Tests：**
- `tests/configuration/schema.test.ts`
- `tests/configuration/projections.test.ts`
- `tests/configuration/configuration-diff-classification.test.ts`
- `tests/configuration/configuration-runtime-coordinator.test.ts`
- `tests/management/server.test.ts`
- 新增 `tests/configuration/span-credentials.test.ts`

**Step 1 — 建立失败测试。** 旧配置无 routing.span 可解析且不改变历史 hash；启用/禁用、缺少 key、非法引用、非法 model、timeout 越界；Planner/Executor 投影无 Span，Kernel 无 apiKeyRef。增加保存新 key、空输入保留、替换后激活失败恢复旧 key 的行为测试。

**Step 2 — 运行并确认仅新增用例失败。**

```sh
npx vitest run tests/configuration/schema.test.ts tests/configuration/projections.test.ts tests/configuration/configuration-diff-classification.test.ts tests/configuration/configuration-runtime-coordinator.test.ts tests/configuration/span-credentials.test.ts tests/management/server.test.ts
```

**Step 3 — 实现配置。** routing.span 为可选对象，内部字段严格校验；model 为 literal，timeoutMs 在 500–10000。缺省值用于新配置/UI 与运行时读取，不重写已保存 revision。diff 把 routing/span 节点增加、删除和字段修改都视为现有 gate 下的 hot-safe 变更。无 key 时运行时回退，格式错误拒绝保存。

**Step 4 — 复用凭据机制。** 激活输入增加独立可选 `spanApiKey`，与 config 分离；从 Management 到 Coordinator 到 staging 传递，禁止原始值参与 diff、render、hash、compile、audit。以服务端固定 reference 写入 SecretStore，并在 prepareConfig 设置引用。Provider 的现有 `secrets: Record<providerRef, key>` 语义保持不变，抽取小型 staging helper 供两种来源共用，不能用保留 providerRef 偷渡 Span。

**Step 5 — 增加状态读模型。** 已鉴权设置查询只返回 configured 布尔值/有限错误；不返回明文或任意引用读取能力。成功保存清理临时对象持有；禁用不删 key。普通配置 probe 不探测可选 Span 网络。

**Step 6 — 重跑上述测试，PASS 后提交。** `feat(configuration): add Span settings with provider-style secret storage`。检查生成 Planner/Executor artifact 和配置响应均不含测试 secret。SecretStore 自身无需更换存储实现。

## Task 2：提取共用合法候选与确定性排序

**Files — 修改：**
- `src/routing/auto-model-resolver.ts`
- `src/routing/configuration-candidate-projection.ts`
- `src/kernel/control-kernel.ts`

**Files — 新增：**
- `src/routing/plan-routing-candidates.ts`（纯配置/工作图候选计算）
- `src/kernel/plan-routing-eligibility.ts`（复用现有健康策略，不导入 SDK/storage）

**Tests：**
- `tests/routing/auto-model-resolver.test.ts`
- `tests/routing/configuration-candidate-projection.test.ts`
- 新增 `tests/routing/plan-routing-candidates.test.ts`
- `tests/kernel/control-kernel.test.ts`

**Step 1 — Characterization。** 固定现有 resolver 输入输出，覆盖 fixed/auto、allowed refs、未知 Driver、disabled Provider/Model、健康、capability、context、cost、latency、quality、preferred refs 和平局。加入多个 Subtask、同 Model 不同 AgentClass/Provider 身份测试。

**Step 2 — 运行测试后提取。**

```sh
npx vitest run tests/routing/auto-model-resolver.test.ts tests/routing/configuration-candidate-projection.test.ts tests/routing/plan-routing-candidates.test.ts tests/kernel/control-kernel.test.ts
```

提取过滤结果与旧 comparator，共用结果包含 eligible、rejected、原 score breakdown、稳定候选身份；不能为了获取候选而把 `AuthorizedExecutorBinding` 当成提前授权结果。Kernel-only 的健康策略从原位置提取，共享纯事实输出。不要虚构当前未接入的实时模型健康或容量来源。

**Step 3 — 验证不变性。** 未传 Span 输入时新旧 resolver 的 binding、fallbackCandidates、rejectedCandidates、scoreBreakdown、policyVersion 完全一致。现有 no-candidate reject/deferred availability 分支不变。

**Step 4 — 提交。** `refactor(routing): share plan candidate eligibility before Span evaluation`。

## Task 3：Span 请求、响应验证与资源上限

**Files — 新增：**
- `src/routing/span-routing-types.ts`
- `src/routing/span-question-builder.ts`
- `src/routing/span-response-validator.ts`
- `src/routing/span-routing-advisor.ts`（外部适配器，只装配在 Server）

**Files — 修改：** `package.json`、`package-lock.json`。

**Tests — 新增：**
- `tests/routing/span-question-builder.test.ts`
- `tests/routing/span-response-validator.test.ts`
- `tests/routing/span-routing-advisor.test.ts`

**Step 1 — 安装锁定依赖。**

```sh
npm install --save-exact @openrouter/sdk@1.3.32
```

查看安装后的 SDK 类型确定 alpha.decisions.create 的参数、AbortSignal、timeout 和关闭 retry 的准确形式。不得用未经验证的 options，不能仅靠 Promise.race 假装取消。SDK 的测试 seam 使用已有 HTTP client/fetch 注入或窄 callable，不建立多模型接口。

**Step 2 — 写 builder/validator 测试并运行。**

```sh
npx vitest run tests/routing/span-question-builder.test.ts tests/routing/span-response-validator.test.ts tests/routing/span-routing-advisor.test.ts
```

候选顺序输入打乱不改变 canonical question 映射；每个 instructions 精确引用不同候选；剔除无关数据；文本脱敏、UTF-8 bytes 限制；response question exact set 和重复身份校验。分别测缺失、额外、NaN、Infinity、越界、非数值、choice/score、错误 model、缺省/错误 usage。匹配真实实测 fixture，不把文档样例当实际 HTTP 证据。

**Step 3 — 定义 observation union。** 共用 envelope 含 schema/policy/question version、eventId、proposal fingerprint、revision、generation、graph revision；每个 Subtask advised 分支有 candidate-set fingerprint、实际模型版本与完整概率，fallback/skipped 分支无评分。所有错误为枚举；unknown error 不持久化原文。

**Step 4 — 请求边界。** 一个 Subtask 一批 noul；32 候选/32KiB request，proposal 128 候选/16 个评估 Subtask/128KiB observation，Server 2 并发，proposal timeout 包含排队与调用，禁用 SDK 重试。超限回退不静默丢候选。使用固定 endpoint，防止高级配置把凭据发往任意 URL。

**Step 5 — 适配器测试。** 使用假的 HTTP/SDK 返回，测试认证/限流/服务端异常、hang 后 abort、取消、缺 key、超时后迟到返回、并发和总 deadline。真实时间只用于少量 abort 集成测试，其他用 fake timers。

**Step 6 — 提交。** `feat(routing): add bounded Span noul evaluation`。

## Task 4：在三个 proposal 入口持久化 observation

**Files — 新增：** `src/session/span-plan-preparation.ts`。

**Files — 修改：**
- `src/session/conversation-session.ts`
- `src/kernel/control-kernel.ts`（KernelEvent 的 optional field）
- `src/server/server-composition.ts`
- `src/account/account-kernel-services.ts`（按实际装配需要）
- `src/account/account-kernel-coordinator.ts`（只在上下文依赖必须穿透时修改，禁止添加网络决策）
- `src/storage/kernel-workflow-repo.ts`（只在重复身份校验必要时修改，不加表）

**Tests：**
- 新增 `tests/session/span-plan-preparation.test.ts`
- `tests/session/conversation-session.test.ts`
- `tests/kernel/kernel-workflow.test.ts`
- `tests/storage/kernel-workflow-repo.test.ts`
- `tests/storage/kernel-decision-repo.test.ts`

**Step 1 — 写闭环测试。** initial、requestKernelReplan、requestKernelMergeReplan 都在落库前添加 observation；disabled/no-choice 零请求；同 submission 复用，不同 fingerprint 冲突；已有 durable event 零请求；取消不入库；非工作请求不调用 Span。

**Step 2 — 定位基线入口。** 初始 `executeSubmittedPlanningAgentPlan` 构造事件后调用 submitKernel；两个 replan 回调返回事件，由 Runtime apply -> markApplied 入库。三个路径都调用同一 preparation；保持 buildPlanProposedEvent 的身份逻辑，不能只修初始提交流程。

**Step 3 — 实现应用编排。** 构造原事件，读 pinned 配置与 snapshot，使用共用纯 eligibility，检查已有事件，调用 Span，附加 observation，重新检查取消/revision/graph 身份，交给已有提交边界。只通过 runtime query port 查事件，Session 不新引入具体 storage adapter。Server 注入 SecretStore-backed 调用；system/recovery binding 不依赖活跃 Client。

**Step 4 — 验证持久化。** 原表 JSON round-trip 保存 observation；ledger 同步包含事件和 audit。重启后 Kernel replay 不构造 SDK 请求，decision/apply 重试复用首次事实。duplicate insert 不以第二份 observation 覆盖第一份。

**Step 5 — 覆盖限制。** 模拟 API 返回前/后、event insert 前/后、issue/apply 前/后崩溃；event insert 前无恰好一次保证，测试按此边界判定。新 replan 事件允许新评估，但必须符合已有 generation revision，不能默认取 active revision。

**Step 6 — 运行并提交。**

```sh
npx vitest run tests/session/span-plan-preparation.test.ts tests/session/conversation-session.test.ts tests/kernel/kernel-workflow.test.ts tests/storage/kernel-workflow-repo.test.ts tests/storage/kernel-decision-repo.test.ts
```

提交：`feat(session): persist Span observations before plan admission`。

## Task 5：Kernel 消费概率、记录审计并保留恢复顺序

**Files — 修改：**
- `src/routing/auto-model-resolver.ts`
- `src/kernel/control-kernel.ts`
- `src/routing/span-routing-types.ts`

**Tests：**
- `tests/routing/auto-model-resolver.test.ts`
- `tests/kernel/control-kernel.test.ts`
- `tests/kernel/control-kernel-architecture.test.ts`
- `tests/execution/kernel-execution-runtime-recovery.test.ts`

**Step 1 — 测试正确性和不变性。** 满分非法候选仍拒绝；Span 只能改变合格候选顺序；fixed 仍固定；每个 AgentClass 只输出一个 binding。对相同 event+snapshot 多次 decide 必须深相等。错 event/revision/generation/subtask/fingerprint 和候选集合变化全部忽略评分；身份合法但某 Subtask 失败仅该 Subtask 回退。

**Step 2 — 实现 comparator。** 同 class 保留旧 preferred capability 比较，然后 Span 概率降序，再旧 comparator。选中模型后按概率排序合法 class，平局沿用 Planner 顺序。无 observation 的路径保持原 policyVersion 和行为；采纳时记 `span-routing-v1`、原基础分、Span 概率及原因。不把概率写进旧 totalScore 冒充同一量纲。

**Step 3 — 恢复路径。** `bindingsForProposalSubtask` 目前会按 Planner 顺序重排，检查 deferred availability 和后续 recovery，确保已授权的 Span 顺序不被无意覆盖。保留非法/不健康候选过滤和配置不可用的 fail-closed；不得靠 Span 打破 unavailable/defer 规则。

**Step 4 — 验证架构。** Kernel 仅导入纯类型/规则，没有 SDK、SecretStore、HTTP、时钟或数据库依赖；Planner proposal 无可伪造的 observation 字段；所有决策在 Kernel 产生。

**Step 5 — 运行并提交。**

```sh
npx vitest run tests/routing/auto-model-resolver.test.ts tests/kernel/control-kernel.test.ts tests/kernel/control-kernel-architecture.test.ts tests/execution/kernel-execution-runtime-recovery.test.ts
```

提交：`feat(kernel): rank eligible bindings with validated Span observations`。

## Task 6：高级设置交互

**Files — 新增：** `web/src/components/SpanRoutingSettings.tsx`。

**Files — 修改：**
- `web/src/components/SettingsPanel.tsx`
- `web/src/config-edit.ts`
- `web/src/api/http.ts`
- `web/src/api/types.ts`
- `web/src/styles.css`（只有现有样式不能覆盖时）

**Tests：**
- `tests/web/config-edit.test.ts`
- `tests/web/settings-workbench.test.ts`
- `tests/e2e/settings-workbench-browser.test.ts`

**Step 1 — Draft 测试。** 从缺省配置打开为关闭；填写 key 后保存，payload 明文只在 spanApiKey；不覆盖 Provider secret；空输入保留；busy/revision conflict 时保留用户草稿；成功清空密码框。

**Step 2 — 实现组件。** 放在现有“高级设置”折叠区域，显示“决策模型（Span）”、启用、固定模型名、OpenRouter API key 和配置状态。简短说明服务不可用会自动使用原路由，以及必要任务摘要会发送到 OpenRouter。不显示 secretRef、question ID、内部 revision 或策略选择。

**Step 3 — 复用保存与状态。** 与 Provider 共用激活流程、编辑禁用态和错误提示；不新建独立保存 authority，不落 localStorage，不从服务端回填明文。禁用保留配置和 key。

**Step 4 — 运行并做浏览器验收。**

```sh
npx vitest run tests/web/config-edit.test.ts tests/web/settings-workbench.test.ts tests/e2e/settings-workbench-browser.test.ts
npm run build:web
```

用隔离 fixture Server 测试关闭/启用/已配置/替换/保存失败，截图和日志不得出现真实 key。复用现有浏览器测试的环境条件；无法运行时明确记缺口。

**Step 5 — 提交。** `feat(web): configure Span credentials in advanced settings`。

## Task 7：系统验收、文档和关闭

**Files — 新增：**
- `tests/e2e/span-routing.test.ts`（mock API + 真 SQLite + 真实 composition seam）
- `scripts/smoke-span-routing.mjs`（读取 SecretStore，输出仅安全摘要）

**Files — 修改：**
- `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- `docs/adr/0023-durable-kernel-workflow-recovery-and-availability.md`
- `CONTEXT.md`
- `docs/current/technical-overview.md`
- `docs/current/technical-overview.zh-CN.md`
- `docs/README.md`
- 本计划的完成记录

**Step 1 — Mock 闭环。** 同任务旧 resolver 与 Span 选择不同合法模型，Kernel 最终 binding 和 Runtime 启动使用一致；API 错误时旧结果完全一致；重启重放 API 调用计数不变；多 Conversation 的 Span 总 deadline/并发上限不互相污染身份；取消保持终态；配置替换回滚不漏 key。读取持久 event、ledger、公开 API、generated runtime，检查测试 secret 不出现。

**Step 2 — 运行验收。**

```sh
npx vitest run tests/e2e/span-routing.test.ts tests/e2e/hot-activation-auto-routing.test.ts tests/gateway/configuration-admission-interlock.test.ts
npm run lint
npm run build
npm test
```

若存在基线失败，用隔离 baseline 复核一次并记录，不能将其称为全部通过。不要为文档-only 阶段运行这组产品测试。

**Step 3 — Docker 持久化与集成检查。**

```sh
docker build -f Dockerfile.test -t metawork-span-test .
docker run --rm metawork-span-test
```

无 DDL 变更仍检查 JSON round-trip/replay。Docker 不可用时保留未完成门，不重复重试掩盖原因。若 vendored Planner 源码未改，无需为本功能修改其构建逻辑；确需验证时遵循 build:offline。

**Step 4 — 真实 Span smoke。** 使用新配置的 SecretStore key，单个 Subtask 的多个合法候选，验证 SDK 返回 noul、实际版本、usage、耗时、有效性；再次 replay 应零请求。手工断网/错误测试 key验证 fallback。不自动写入用户正在使用的安装配置，不把真实凭据写入脚本/CLI 参数/git。

真实 smoke 未取得环境/key时标注未运行，不影响其他实现和 mocked 验收继续。此前手工调用成功不能替代这一步。

**Step 5 — 排序质量检查。** 固定样本包括简单代码改动、复杂代码任务、研究任务和单候选任务；记录两种策略的 binding、硬过滤结果、Span 延迟和 fallback 率，不根据概率声称实际成功率提高。新功能仍默认关闭。

**Step 6 — 修订权威文档。** ADR-0033 增加唯一 Span 评分输入、精确排序和配置说明；ADR-0023 记录外部观测入事件和崩溃窗口。CONTEXT/技术总览明确 source 行为与部署状态。Span usage 只做内部审计，本期无新增用户扣费协议。不为未来模型增加抽象。

**Step 7 — 评审与提交。** 重点复查取消/replan、重复事件、配置激活失败、硬约束与 secret 隔离。提交 `feat: complete Span routing integration and validation`。记录完成日期、实际命令结果、未通过/未运行门、交付行为与 closing commit；只在源实现和所需验收完成后将计划改为完成，部署单独记录。

## 验收矩阵

| 场景 | 预期 |
| --- | --- |
| 旧配置/禁用/仅一个候选 | 零网络请求，旧 deterministic 结果 |
| 多候选成功 | noul 影响合法模型/class 顺序，Kernel 产生最终 binding |
| 非法候选满分 | 不发送给 Span，不授权 |
| Span 缺 key/认证失败/限流/超时 | 有限错误枚举，旧 resolver 结果 |
| 某 Subtask 缺少一个答案 | 整个 Subtask 回退，其余独立处理 |
| 取消或 shutdown | abort，无迟到入库、无新 attempt |
| 候选/revision/graph 不匹配 | 废弃评分；配置错误仍原样拒绝 |
| API 返回后入库前 crash | 允许重试请求，明确重复成本边界 |
| event 已入库后 restart | 复用 observation，零 API 请求 |
| initial/replan/conflict_replan | 同一 preparation，保留原 generation revision |
| deferred/retry/fallback | 不重打 Span，使用已有授权顺序 |
| 配置激活失败 | Provider 与 Span key 一起恢复 |
| 日志/客户端/Planner/Executor artifacts | 不含明文 key 或原始 Span 请求/响应 |

## 计划交付记录

- 已完成：核对 main 基线、Provider SecretStore staging、advanced settings、模型过滤/Kernel 健康边界、三个 proposal 入口、事件与 ledger 存储；创建隔离分支及设计/计划。
- 已交付（按任务顺序，均在本分支）：
  1. `feat(configuration): add Span settings with provider-style secret storage` — `routing.span` 配置、安全投影、Span 凭据 staging 与回滚、管理接口与状态端点。
  2. `refactor(routing): share plan candidate eligibility before Span evaluation` — 共用 `planSubtaskCandidateGroups` 与 `filterEligibleModelCandidates`，Span 概率作为 resolver 的一个排序信号。
  3. `feat(routing): add bounded Span noul evaluation` — `@openrouter/sdk@1.3.32` 适配器、问题构建、响应校验、超时/abort/并发/预算限制。
  4. `feat(session): persist Span observations before plan admission` — `plan_proposed` 新增可选 `spanRouting`，initial/replan/conflict_replan 三入口统一富化。
  5. `feat(kernel): rank eligible bindings with validated Span observations` — Kernel 重校验观察并仅对已授权候选排序，deferred availability 保留授权顺序。
  6. `feat(web): configure Span credentials in advanced settings` — 高级设置新增 Span 面板与草稿/密钥流程。
  7. 本任务：系统验收、真实 smoke 脚本与权威文档修订。
- 已验证（本机 macOS，Node 22.23.2）：`npx tsc --noEmit`（根工程）、`web` 的 `tsc --noEmit` 与 `vite build`、`tests/routing`、`tests/kernel`、`tests/configuration/span-routing-config.test.ts`、`tests/session/span-plan-preparation.test.ts`、`tests/session/conversation-session.test.ts`、`tests/session/planning-kernel-path.test.ts`、`tests/e2e/span-routing.test.ts`、`tests/web/config-edit.test.ts`、`tests/web/settings-workbench.test.ts`、`tests/management/server.test.ts`。
- 未执行（环境/凭据门）：真实 `npm run smoke:span-routing`（需要已轮换的 OpenRouter Key）、Docker `Dockerfile.test` 持久化回归、Chrome 浏览器 E2E `tests/e2e/settings-workbench-browser.test.ts`（整体被跳过）。
- 全量测试证据（本机 macOS，`npm test`，2026-09-27）：`Test Files 10 failed | 422 passed | 5 skipped (437)`，`Tests 11 failed | 2665 passed | 12 skipped (2688)`。
- 上述 11 个失败均已在基线 `55184d8` 的独立 worktree 中相同复现（vendored Planner CLI 未构建、Docker 不可用、以及既有测试/实现差异），与本次 Span 变更无关：
  `tests/planning/planner-process-supervisor.test.ts`、`tests/session/task-boundary-round3-acceptance.test.ts`（2）、`tests/session/scripted-session.test.ts`、`tests/docker/shell-schema-isolation.test.ts`、`tests/billing/bill-finality.test.ts`、`tests/session/executor-router-command-acceptance.test.ts`、`tests/configuration/configuration-module-boundary.test.ts`、`tests/session/inline-materials-round7-acceptance.test.ts`、`tests/session/input-controller.test.ts`、`tests/session/inline-web-links-round8-acceptance.test.ts`。
- 新增/相关测试均通过：`tests/configuration/span-routing-config.test.ts`（12）、`tests/routing/plan-routing-candidates.test.ts`（12）、`tests/routing/span-routing.test.ts`（23）、`tests/kernel/span-routing-kernel.test.ts`（10）、`tests/session/span-plan-preparation.test.ts`（9）、`tests/e2e/span-routing.test.ts`（3）、`tests/web/config-edit.test.ts`（10）。
- 已知偏差：高级设置在 Span 关闭且从未配置时不写入 `routing` 节点，避免无关节省。

### 评审修正（2026-09-27）

实现完成后的独立评审发现 8 处与设计不一致或未完成项，均已修复并补回归测试：

| 问题 | 修复 |
| --- | --- |
| 取消期间仍会提交 Kernel 事件 | Turn 级 `AbortController`：取消时 abort 进行中的请求，提交前再次核对取消闩锁 |
| 已入库事件重交时重复评分 | `preparePlanProposedEvent` 先经 runtime port 查 `findKernelEvent(event.id)`，命中则直接复用存储事件 |
| 并发上限按提案而非 Server 共享 | `ConcurrencyLimiter` 提升为 advisor 实例级共享，排队计入总截止时间 |
| Span 凭据与同名 Provider 冲突 | SecretStore 新增非 Provider `internal` 命名空间；引用改为 `file-secret:anyfusion/internal/routing-span` |
| 凭据解析不受截止时间约束且异常外抛 | advisor 内限时解析，超时/失败归一为 `span_timeout`/`span_secret_unavailable` 回退 |
| 请求缺少真实模型身份与用途/成本信息 | state 增加 `modelId`、`reasoning`、`contextLimit`、`costTier`；`questionVersion` 提升为 `span-fit-v2` |
| smoke 把空答案集当成功 | 改用与产品一致的严格校验（集合完整 + finite + [0,1]） |
| smoke 回显原始 SDK/Provider 错误 | 只输出有限 `errorCode` 与可选 `httpStatus` |
| 凭据未按 pinned revision 解析 | Server 改为 `getSnapshot(event.configurationRevision)` |

补充的回归测试：`tests/session/span-routing-session-integration.test.ts`（4）、`tests/routing/span-routing-smoke-script.test.ts`（4），以及 `credentials-file-secret-store`、`span-routing-config`、`span-routing` 中的命名空间隔离、跨提案并发、限时凭据、模型身份与取消用例。

修正后重跑全量（本机 macOS，`npm test`）：`Test Files 10 failed | 424 passed | 5 skipped (439)`，`Tests 11 failed | 2684 passed | 12 skipped (2707)`。
失败的 11 个与基线 `55184d8` 完全相同（同一批 Planner CLI 未构建 / Docker 不可用 / 既有测试与实现差异），无新增回归。

额外发现并修复：并发限制器在“让位”时先递减计数再授权，导致让位后新到达的请求会在两个槽位仍被占用时被准入。现已改为由等待者直接继承槽位，并新增“让位后不得过准入”回归测试（修复前 peak=3，修复后 peak≤2）。

该轮结束时仍未完成：system/recovery 绑定未注入 advisor；真实 OpenRouter smoke 与 Docker 验证未执行。此处为历史记录，后续设计收尾已补齐恢复入口并完成缓存 Node 22 镜像中的 Docker 验收。

### 评审修正（第二轮，2026-09-27）

复核第一轮修复后又发现 5 处未闭合边界，均已修复并补回归：

| 问题 | 修复 |
| --- | --- |
| replan/conflict_replan 在 Span 等待期间取消后仍返回可入库 `plan_proposed` | preparation 返回 `null`；重规划入口透传 `null`；Runtime 将 generation 请求置 `cancelled` 而非 `failed`，不入库 |
| `routing.span.apiKeyRef` 可为任意（含其他 Provider 的）secret 引用 | schema 收紧为 `SPAN_ROUTING_SECRET_REFERENCE` 字面量；Server 解析前再次核对常量 |
| smoke 在 internal 缺失时回退读取同名 Provider Key | 删除 Provider 回退分支，凭据来源与实际读取位置一致 |
| Session/Server 关闭不 abort 进行中的 Span 请求 | `dispose()` 先 abort；Server 关闭入口 abort 共享 `lifetimeSignal`；advisor 合并信号并在 abort 时 fail-closed |
| 跳过的 Subtask 误占 16 个评估名额，且超限原因误记为 `single_candidate` | 只按实际请求计数；超限记 `span_proposal_budget_exhausted` |

新增回归：`tests/execution/kernel-execution-runtime-replan.test.ts`（2）、`tests/storage/generation-replan-request-repo.test.ts` 新增 1 条，`tests/session/span-routing-session-integration.test.ts`（8）、`tests/session/span-plan-preparation.test.ts`（11）、`tests/routing/span-routing.test.ts`（32）、`tests/routing/span-routing-smoke-script.test.ts`（6）、`tests/configuration/span-routing-config.test.ts`（13）。

验证（本机 macOS，Node 22）：`npx tsc --noEmit` 通过；`tests/configuration`+`tests/routing`+`tests/kernel`+`tests/architecture`+`tests/management`+`tests/web` → `1 failed | 782 passed`（仅基线 `configuration-module-boundary`）；`tests/execution`+`tests/storage`+`tests/account`+`tests/e2e` → `403 passed | 6 skipped`；`tests/session` → `7 failed | 240 passed | 3 skipped`，7 个失败与基线 `55184d8` 完全相同（无新增回归）。全量 `npm test` 未在本轮重跑；真实 OpenRouter smoke、Docker 持久化、浏览器 E2E 仍未执行。
- 文档 closing commit：`181a65a docs: plan Span routing integration`。
- 产品实现 closing commit：`4190eea`。

### 设计收尾复核（2026-09-27）

[收尾记录](2026-09-27-span-design-closure.md)取代前两轮的完成范围判断。新增无客户端
恢复入口、完整配置固定、并发去重与身份冲突检查、不可变取消信号、可恢复关闭中断、
排队上限、双向凭据隔离及四类任务的集成 smoke。Planner 按每次运行固定模型和环境，
避免旧 revision 的请求终止其他会话。

最终集中测试 16 文件/175 项、Chrome 4 项通过；Docker 缓存 Node 22.23.2 镜像中
9 文件/82 项及 Planner 并发 1 项通过。宽范围回归 930 项通过、1 个已知基线失败；
Planner seam 另有 40 项通过、1 个已知 CLI 构建基线失败。完整构建、根/Web 类型检查通过。
本轮没有重跑全量 `npm test`。精确 Dockerfile 基础镜像拉取被 Docker Hub 超时阻断；
真实 API 后续验收已完成，见[验收记录](2026-09-27-span-live-acceptance.md)。用户授权了当前
Key，真实测试发现并修复了 Respan 要求字符串 `state` 的协议差异；三个评分场景、
单候选跳过、默认 3 秒超时回退和重放零追加调用均通过。相关回归 71 项通过，构建与类型
检查通过。精确 Dockerfile 再次尝试仍阻断于 Docker Hub token 请求超时。
没有推送、合并或部署。
