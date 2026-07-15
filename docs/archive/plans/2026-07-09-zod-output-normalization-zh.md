# 计划：用 zod 规范化 LLM 输出结构

- 日期：2026-07-09 · 分支 `QC` · 基线 `97fad72`
- 范围：引入 zod，把手写 LLM 输出 parse/coerce 换成 schema 校验。不加功能、不引 AI SDK、不动 spawn/fallback/prompt 语义。
- 交接依据：`handoff-zod-output-normalization.md`。
- **源码已逐行核对**（llm-bridge.ts / codex-planning-agent.ts / planning-agent-plan-validator.ts / planning-types.ts / capability-class.ts / llm-json.ts / id.ts / 现有两个测试）。下述每条决策带行号依据。

## 0. 决策表（已与用户逐条敲定）

| # | 决策点 | 选定 | 源码依据 |
|---|---|---|---|
| A | zod 与 validator 职责 | zod 当类型化 coerce，**永不 reject**；`validatePlanningAgentPlan` 一行不改，仍是唯一裁决门 | validator 做枚举集合校验+跨字段业务+依赖图环检测（validator.ts:30,38-43,55-115），zod 不擅此 |
| B | 依赖 context 的默认值 | 纯静态 schema + `applyContextDefaults(plan, context)` 纯函数；schema 不 import context | coerceToPlan 里 6 处 context 默认（见 §2 表） |
| C | plan id（随机）/ subtask id（序号）兜底 | 并入 `applyContextDefaults`；schema 用占位空串 | `generateInteractionId` 用 nanoid（id.ts:27）是随机源，不能进静态 `.default`；validator 要求 id 非空（validator.ts:29），故 applyContextDefaults 必须把空串换 plan_xxx |
| D | confidence/score clamp | `preprocess`：`Number(v)`+`Math.max(0,min(1,x))`，非有限值落默认；越界 clamp 对齐今天，**字符串数字兼容是有意增强**（今天字符串落 0/undefined） | llm-bridge.ts:269-271（confidence）、321-324（score）。**为何不用 `z.coerce.number().min().max().catch(0)`**：越界值 `1.5` 今天 clamp 到 1.0，该写法会落 0（min/max 失败→catch）——行为漂移 |
| E | fence 剥离 | 四个 parser 统一改用 `extractJsonObject`，删各自内联剥离 | llm-bridge.ts:267,295,304,349 四份重复内联。`extractJsonObject` 有外部调用方（codex-planning-agent.ts:77），**保留不删**；删的只是四个 parser 的内联 |
| — | parser 失败兜底（行为硬约束，非敲定项） | 每个 parser 保留自己的 try/catch，兜成各自的 fallback | `extractJsonObject` 在无花括号时**抛错**（llm-json.ts:11-13），必须由 parser catch |
| G | preference `preferenceId`/`id` 别名 | schema 用 preprocess 把 `id` 重命名为 `preferenceId`；白名单 `.filter(validIds.has)` 留 schema 之后 | llm-bridge.ts:312-316 先试 preferenceId 再试 id；317 白名单过滤 |
| H | 死代码清理 | 全删 | codex-planning-agent.ts 的 coerce*（95-206）+ helper（372-392）+ 6 顶部 Set（30-47）；llm-bridge 的 4 处内联剥离 |
| I | PlanningAgentPlanSchema 位置 | 新建 `src/planning/planning-agent-plan-schema.ts`（schema + applyContextDefaults） | — |
| J | llm-bridge 的 4 个 parser schema | 放 `llm-bridge.ts` 底部模块级 const（与 `summarizeProcessText` 同风格） | llm-bridge.ts:383 |
| K | 回归测试 | 在现有两个测试文件补 zod 边界 case，不新建文件 | — |
| L | asString/asStringArray/clampConfidence | 用 zod 原生能力；asStringArray 必须 preprocess filter（不能纯 `.catch([])`） | **为何 asStringArray 不能用 `z.array(z.string()).catch([])`**：混合数组 `['a',1,'b']` 今天 filter 出 `['a','b']`（llm-bridge.ts:297 / codex asStringArray:385），该写法会让整个数组校验失败→落 `[]`，丢数据 |

## 1. llm-bridge.ts 改造（先做，低风险）

### 1.1 四个 parser 改造要点

**方法名/签名/可见性/返回类型全部不变**（测试用 `(bridge as any).parseXxx` 直调，llm-bridge.test.ts:66,91,97,131）。

| parser | today fallback | zod 后 |
|---|---|---|
| `parseTaskPriorityResult` | `{priority:'normal', reason:'priority 解析失败，fallback normal'}`（llm-bridge.ts:359） | extractJsonObject + PrioritySchema.safeParse；失败→同 fallback |
| `parseRankResult` | `[]`（llm-bridge.ts:299） | extractJsonObject + RankSchema.parse；RankSchema 自带 preprocess filter，非数组/解析失败→`[]`，混合数组只保留字符串 |
| `parseTaskResumeIntentResult` | `{action:'none',taskId:null,reason:'resume intent 解析失败，fallback',confidence:0}`（llm-bridge.ts:290） | extractJsonObject + ResumeIntentSchema.safeParse；失败→同 fallback |
| `parsePreferenceRecallResult` | `[]`（llm-bridge.ts:338） | extractJsonObject + PreferenceRecallArraySchema.parse；逐项 PreferenceRecallItemSchema.safeParse，成功项再 `.filter(validIds.has)`（白名单） |

### 1.2 两个语义陷阱（实现时必查，非偏好）

**陷阱 1 — priority 非法 = 整包换 fallback**（与 codex 顶层枚举相反）。
- 今天 llm-bridge.ts:351 `if (parsed.priority === 'normal'||...)` 不命中→落 fallback（line 359），priority 和 reason 都换。
- zod 里 priority 用 `z.enum([...3...])` **不加 `.catch`**：非法→safeParse 失败→走 fallback 分支。
- **不要**用 `.catch('normal')`：那会静默改值、保留 LLM 的 reason，偏离今天。

**陷阱 2 — resume 的 reason 默认串按 action 分支不同**（静态 `.default()` 给不了分支默认）。
- resume 分支默认串 `'LLM 语义判断恢复已有任务'`（llm-bridge.ts:276）；none 分支 `'LLM 语义判断不是恢复任务'`（llm-bridge.ts:284）。
- 这两个分支默认 + none 时 taskId 强制 null（llm-bridge.ts:283），放 parser 的 safeParse 后处理，**不塞进 schema**。

### 1.3 底部模块级 schema

- `ClampedConfidence`（决策 D，`default(0)`）。**有意兼容增强**：preprocess 用 `Number(v)`，字符串数字 `'0.91'`→0.91（今天 llm-bridge.ts:269 严格 `typeof===number` 会落 0）。这是偏离今天的行为扩展，文档与测试明确标注。
- `ClampedScore`（决策 D，保留 undefined 三态：缺省/非数字→undefined，数字越界→clamp）。同上字符串数字兼容增强（今天 llm-bridge.ts:321 严格 `typeof===number`，字符串落 undefined）。注意：score 的非数字仍落 undefined（不是 0），与 confidence 不同。
- `PrioritySchema`：`priority: z.enum([...3...])`（无 catch，陷阱1）、`reason` 非字符串时默认 `'LLM 语义优先级判断'`（可用 preprocess 实现，对齐 llm-bridge.ts:354）。
- `RankSchema`：**preprocess filter**，不是 `z.array(z.string())`。今天 llm-bridge.ts:297 对混合数组 `['a',1,'b']` 过滤出 `['a','b']`；`z.array(z.string())` 会整包失败→`[]`。写法：`z.preprocess(v => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [], z.array(z.string()))`。非数组→`[]`。
- `ResumeIntentSchema`：字段**全 optional/nullish**，safeParse 不因缺字段失败。今天 llm-bridge.ts:272-290 先判 `action`，reason/taskId 缺省时在分支内给默认——若字段 required，缺省会先 safeParse 失败走 fallback，行为变了。写法：`action: z.enum(['resume','none'])`、`taskId: z.string().nullable().optional()`、`reason: z.string().optional()`、`confidence: ClampedConfidence`。action 既非 resume 也非 none 时（safeParse 失败）→parser 走 fallback（对齐今天 line 290）。resume/none 的 reason 分支默认 + none 时 taskId 强制 null，在 parser safeParse 后处理（陷阱2）。
- `PreferenceRecallItemSchema`：preprocess 把 `id`→`preferenceId`（决策 G）；`reason` 默认 `'executor 判定当前偏好适用'`（llm-bridge.ts:330，条件是非空 trim 后字符串）；`score: ClampedScore`；`action` 用 preprocess 把非 `auto_apply|ask_review|suppress` 规整为 `undefined`，再接 `z.enum([...3...]).optional()`——**不是直接 `.optional()`**。直接 `.optional()` 遇非法字符串（如 `'maybe'`）会校验失败拖垮该项；preprocess 才能实现"非法→undefined，该项保留"（对齐 llm-bridge.ts:341-345）。
- `PreferenceRecallArraySchema`：**逐项 safeParse 过滤**，不是 `z.array(ItemSchema)`。今天 llm-bridge.ts:310-335 逐项 map/filter，坏项返回 null 再 filter，好项不受影响；`z.array(ItemSchema)` 任一项失败整组失败。写法：`z.array(z.unknown())` 拿原始数组，parser 里对每项 `PreferenceRecallItemSchema.safeParse`，成功的收集、失败丢弃，再 `.filter(validIds.has)`。

### 1.4 删除

- 四份内联 fence 剥离 + JSON.parse（llm-bridge.ts:267,295,304,349）。
- `parsePreferenceRecallAction`（llm-bridge.ts:341-345，被 action preprocess schema 取代）。
- **保留不动**：`normalizeTaskResumeIntentResult`（llm-bridge.ts:369，做 taskId 白名单业务校验，public 路径 `resolveTaskResumeIntent` 用，不在 parse 层）、`fallbackTaskPriorityResult`（public `resolveTaskPriority` 的 catch 用，不在 parse 层）。

## 2. 新建 planning-agent-plan-schema.ts（后做，风险中）

### 2.1 schema：顶层枚举用 `.catch(默认)`，子任务枚举保留 raw 值

**顶层枚举**（缺省/非法都静默落默认，复刻 SET.has?v:'默认'，codex-planning-agent.ts:100,121,123,130,133,145）：
`action→'clarification'`、`task.binding→'none'`、`task.control→'none'`、`execution.complexity→'simple'`、`risk.level→'low'`。`execution.mode` 与 `capabilityClass` 不能纯静态默认：schema 保留 raw/unknown，`applyContextDefaults` 里分别按 action 兜底（plan_work_graph→single_executor/general，否则 none/conversation）。

**子任务枚举**（缺省给默认、present 透传含非法，复刻 `enumOrRaw`，codex-planning-agent.ts:379-381）：
`requiredAgentClassKind`、`riskLevel`、`expectedOutput` 在 schema 里用 `z.unknown().optional()` 保留 raw 值；`applyContextDefaults` 用 `enumOrRaw(raw, fallback)` 只在 `undefined|null|''` 时兜底。present 但非法（如 `'nonsense'` 或 `1`）原样透传，由 validator.ts:72-79 拒绝→触发 repair。测试 codex-planning-agent.test.ts:133-161 锁此行为。

**`schemaVersion: 1`**：用 `.default(1)` 或字面量保证输出（validator.ts:28 校验）——**计划前版本漏了此字段**。

**漏掉的字段补全**（计划前版本遗漏）：
- `source: 'codex-planner'`：schema 里保证输出为 `'codex-planner'`（可用 `z.literal(...).catch(...)`；codex-planning-agent.ts:152、239；测试 codex-planning-agent.test.ts:88 检查）。validator 不校验，但下游/测试依赖。
- `expectedOutput` 的默认依赖 `capabilityClass`：`code_edit→'patch'`，否则 `'summary'`（codex-planning-agent.ts:192-195）。这是**跨字段默认**，不能进静态 schema，放 `applyContextDefaults`。schema 里 `expectedOutput` 必须保留 `undefined/''`，让 applyContextDefaults 能区分"LLM 没给"和"LLM 明确给 summary"。

### 2.2 applyContextDefaults 要复刻的 context 默认（逐字段）

| 字段 | 今天默认 | 依据 |
|---|---|---|
| `plan.id` | 空→`plan_${generateInteractionId()}`（随机） | codex-planning-agent.ts:111；validator.ts:29 要求非空 |
| `task.title` | plan_work_graph 且空→`context.userInput.slice(0,50)`，否则 null | codex-planning-agent.ts:125 |
| `task.goal` | plan_work_graph 且空→`context.userInput`，否则 null | codex-planning-agent.ts:126 |
| `execution.mode` | 空/none 时：plan_work_graph→`'single_executor'`，否则 `'none'` | codex-planning-agent.ts:130-132 |
| `execution.canModifyFiles` | `rawFlag && context.allowFileModification` | codex-planning-agent.ts:139 |
| `execution.capabilityClass` | 非 isCapabilityClass 时：plan_work_graph→`'general'`，否则 `'conversation'` | codex-planning-agent.ts:108,201-206 |
| `workGraph` | 非 plan_work_graph→强制 null（即使 LLM 给了也清） | codex-planning-agent.ts:149-151 |
| `subtask.id` | 空→`subtask_${index+1}`（序号，不随机） | codex-planning-agent.ts:185 |
| `subtask.title` | 空→`context.userInput.slice(0,50) || 'Execute task'` | codex-planning-agent.ts:186 |
| `subtask.goal` | 空→`context.userInput` | codex-planning-agent.ts:187 |
| `subtask.expectedOutput` | 空→`capabilityClass==='code_edit' ? 'patch' : 'summary'` | codex-planning-agent.ts:192-195 |

### 2.3 codex-planning-agent.ts 改造

- `plan()` 里 `coerceToPlan(extractJsonObject(raw), context)` → `PlanningAgentPlanSchema.safeParse` + `applyContextDefaults`。attempt 循环与 repair 语义不变（codex-planning-agent.ts:64-88）。
- safeParse 永不失败（决策 A），但 `extractJsonObject` 抛错仍由外层 catch 兜（codex-planning-agent.ts:77-81）。
- 删除：coerce* 四方法（95-206）、helper asString/enumOrRaw/asStringArray/clampConfidence（372-392）、6 顶部 Set（30-47）。
- 保留：`extractJsonObject` import（仍在用）、`buildPrompt`/`buildRepairPrompt`/`conservativeFallbackPlan`/`summarizeAgentClass`/`PLAN_SCHEMA_EXAMPLE`/`withTimeout`。`isCapabilityClass` import 移到 schema 文件（applyContextDefaults 用）。

## 3. 行动顺序

1. `npm install zod`（进 `dependencies`）。
2. 改 `llm-bridge.ts`（§1）。
3. 新建 `planning-agent-plan-schema.ts`（§2.1-2.2）。
4. 改 `codex-planning-agent.ts`（§2.3）。
5. 补回归测试（§4）。
6. 验证（§5）。
7. 提交。

## 4. 回归测试（决策 K）

- `tests/core/llm-bridge.test.ts` 补：
  - confidence 越界 `1.5`→clamp 1.0（行为不变）。
  - confidence 字符串 `'0.91'`→0.91 —— **明确标注为兼容增强**（今天落 0），不是行为不变。
  - preference `{id:'x'}` 别名识别 + 无效 id 白名单过滤；preference `{action:'maybe'}` 非法→该项 action 为 undefined 但不被丢弃（陷阱4）。
  - rank 混合数组 `['a',1,'b']`→`['a','b']`（过滤不整包失败）。
  - priority 非法值→整包 fallback（陷阱1）。
  - resume 缺 taskId/reason 时仍按 action 给分支默认（不因缺字段走 fallback，陷阱2）。
- `tests/planning/codex-planning-agent.test.ts` 补：顶层非法 action 静默默认（不触发 repair）；空 workGraph；expectedOutput 缺省时 code_edit→patch 跨字段默认；`source==='codex-planner'`（已有断言，确保改造后仍绿）。
- **不放宽任何 fallback 语义断言。**

## 5. 验证

1. host `npm run lint`（`tsc --noEmit`）干净——唯一能在 Windows host 可靠跑的检查。
2. Docker 全量：`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test` → 728+ passed、0 失败。
3. 仅在测试全绿后提交，分支 `QC`，`refactor(core): validate LLM outputs with zod schemas`。

## 6. 不做

不引 AI SDK；不碰 embeddings / prompt-builder / executor adapter；不动 `LlmBridge.query` spawn 逻辑；不改 `validatePlanningAgentPlan`；不动 prompt 文本；不清理 session/tui 测试里的 legacy mock 脚手架。

## 7. 风险登记

| 风险 | 对应 |
|---|---|
| `generateInteractionId` 随机源不能进静态 `.default` | 决策 C：放 applyContextDefaults |
| 子任务枚举 present-but-invalid 必须透传触发 repair | 决策 A：schema 用 `z.unknown().optional()` 保留 raw，`applyContextDefaults` 用 enumOrRaw 缺省兜底/present 透传 |
| 顶层枚举非法要静默默认不触发 repair | `.catch(默认值)` |
| confidence 越界今天 clamp 不拒绝 | 决策 D：preprocess 复刻 Math.max/min |
| **RankSchema 不能用 `z.array(z.string())`** | preprocess filter 混合数组（§1.3）——`z.array(z.string())` 对 `['a',1,'b']` 整包失败→`[]`，丢数据 |
| **ResumeIntentSchema 字段不能 required** | 字段全 optional/nullish（§1.3）——required 会让缺 taskId/reason 的合法输入先 safeParse 失败走 fallback |
| **PreferenceRecallArraySchema 不能用 `z.array(ItemSchema)`** | `z.array(z.unknown())` + 逐项 safeParse 过滤（§1.3）——否则坏项拖垮整组 |
| **preference action 不能直接用 `.optional()`** | 先 preprocess 非法值→`undefined`，再 `.optional()`（§1.3）——直接 `.optional()` 遇非法字符串校验失败，无法实现"非法→undefined 但保留该项" |
| `extractJsonObject` 抛错打破 parser fallback | 每个 parser 保留 try/catch（§1.1） |
| rank 期望数组，extractJsonObject 对象兜底对数组无效 | 靠 parser try/catch 兜 `[]`，行为与今天一致（llm-bridge.ts:299 也无数组兜底） |
| preference score 三态 | ClampedScore 保留 undefined（§1.3） |
| resume action='none' 时 taskId 强制 null + reason 分支默认 | parser safeParse 后处理（陷阱2） |
| `schemaVersion` 必须输出 1 | §2.1 补 `.default(1)`（计划前版本漏） |
| `source` 必须为 `'codex-planner'` | §2.1 保证 schema 输出 `'codex-planner'`（计划前版本漏） |
| `expectedOutput` 默认依赖 capabilityClass | §2.2 放 applyContextDefaults（计划前版本漏） |
| confidence/score 字符串数字兼容是**有意增强**非行为不变 | §1.3 明确标注；今天字符串落 0/undefined，改造后转数字（用户已确认保留） |
