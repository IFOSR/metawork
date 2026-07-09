# zod schema 写法优化清单（第一类：语法地道化）

> 状态：**待做**。基线 `QC` 分支（zod 引入后，见 `docs/plans/2026-07-09-zod-output-normalization-zh.md`）。
>
> 背景：`2026-07-09` 那轮重构把手写 parse/coerce 换成 zod schema，为了 **1:1 复刻旧行为** 用了不少 `z.preprocess(...)` 绕法。事后复盘发现其中一部分是"重新发明了 zod 原生能力"——可以换成更地道、更短的写法，**行为完全等价**。本文只登记这一类（安全、纯语法）。真正需要动校验架构的"根本优化"（枚举清单在 schema 与 validator 里重复两套）不在此列,见文末。

## 前置约束（改动时必须守住）

- **不改 `validatePlanningAgentPlan`**：它仍是唯一裁决门。
- **不改任何 fallback 语义**：现成回归测试已把行为锁死
  （`tests/core/llm-bridge.test.ts`、`tests/planning/codex-planning-agent.test.ts`）。
- **验收**：`npm run lint` 干净 + Docker 全量测试保持绿
  （`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test`，当前 738 passed）。
  每处改完都应无需改测试即通过——这正是"等价"的证明。

## 清单

### 1. preference `action`：`preprocess` 重新发明了 `.catch()` — `src/core/llm-bridge.ts`

当前（约 llm-bridge.ts:391）：

```ts
const PreferenceRecallActionSchema = z.preprocess(
  value => value === 'auto_apply' || value === 'ask_review' || value === 'suppress' ? value : undefined,
  z.enum(['auto_apply', 'ask_review', 'suppress']).optional(),
);
```

改为：

```ts
const PreferenceRecallActionSchema =
  z.enum(['auto_apply', 'ask_review', 'suppress']).optional().catch(undefined);
```

- 语义等价：`'maybe'` → enum 失败 → `.catch(undefined)`；字段缺省 → `.optional()`。
- 收益：去掉一层 preprocess，"非法值→兜底"用 `.catch()` 表达本职意图，更直白。
- 注意：改完后 `PreferenceRecallItemSchema` 里那个 `as z.ZodType<MemoryApplicabilityAction | undefined>` 强转大概率可以去掉（enum 推断已是该联合类型），改时顺手确认 `tsc` 是否还需要它。
- 锁定测试：`tests/core/llm-bridge.test.ts` "keeps valid preference items when aliases and invalid actions are present"（`action:'maybe'` → undefined 但该项保留）。

### 2. `StringOrEmptySchema`：`preprocess` 重新发明了 `.catch('')` —— 铺得最广，收益最大

出现在 **两个文件**：`src/core/llm-bridge.ts` 与 `src/planning/planning-agent-plan-schema.ts`（后者 schema.ts:35-38）。planning-agent-plan-schema 里被 `id`/`reason`/`title`/`goal`/subtask 各字段引用十余次。

当前：

```ts
const StringOrEmptySchema = z.preprocess(
  value => typeof value === 'string' ? value : '',
  z.string(),
);
```

改为：

```ts
const StringOrEmptySchema = z.string().catch('');
```

- 语义等价：数字 `1`/`undefined`/`null` → parse 失败 → `''`；正常字符串透传。
- 收益：用得最多的一个 schema，改法最简单、覆盖面最广。
- 锁定测试：几乎所有 codex-planning-agent 用例都间接覆盖（`id`/`title`/`goal` 空串兜底后由 `applyContextDefaults` 补默认）。

### 3. preference 数组逐项过滤：把"解析容错"从 parser 体下沉进 schema — `src/core/llm-bridge.ts`

当前 schema 只拿原始数组，容错逻辑手写在 `parsePreferenceRecallResult` 体里（llm-bridge.ts:298-311 一带）：

```ts
const PreferenceRecallArraySchema = z.preprocess(
  value => Array.isArray(value) ? value : [],
  z.array(z.unknown()),
);
// parser 体：
return PreferenceRecallArraySchema.parse(extractJsonObject(raw))
  .map(item => {
    const parsed = PreferenceRecallItemSchema.safeParse(item);
    if (!parsed.success || !validIds.has(parsed.data.preferenceId)) return null;
    return parsed.data;
  })
  .filter((item): item is PreferenceRecallDecision => Boolean(item));
```

改为——用元素级 `.catch(null)` 让 zod 自己做"坏项丢弃"，parser 里只留运行时才需要的白名单过滤：

```ts
const PreferenceRecallArraySchema = z.preprocess(
  value => Array.isArray(value) ? value : [],
  z.array(PreferenceRecallItemSchema.catch(null)),   // 坏项→null，不拖垮整组
);
// parser 体：
return PreferenceRecallArraySchema.parse(extractJsonObject(raw))
  .filter((x): x is PreferenceRecallDecision => x !== null && validIds.has(x.preferenceId));
```

- 职责更清：schema 负责"解析容错"，parser 只留 `validIds` 这个**运行时数据**才需要的过滤。
- 语义等价：坏项照样丢，好项照样留，白名单照样过滤。
- 注意：确认 zod v4 里 `PreferenceRecallItemSchema.catch(null)` 的类型推断（元素类型变成 `Item | null`），`.filter` 的类型守卫要相应收窄。
- 锁定测试：同 #1 那条用例（一个合法项保留、一个 `validIds` 不含的项丢弃）。

## 不在本清单内（本质复杂度，别动）

- **`RankSchema` 的 preprocess-filter**：`['a',1,'b']`→`['a','b']` 是"尽力解析排名列表"的合理语义，过滤本身就是对的。
- **`applyContextDefaults` 的存在**：`plan_${nanoid()}`（随机源）、`context.userInput`、`allowFileModification`（运行时数据）静态 schema 放不进去，拆分正确。
- **subtask 枚举用 `z.unknown().optional()`**：故意让 zod 不校验，把 present-but-invalid 值透传给 `validatePlanningAgentPlan` 去 reject、触发 repair 重试。设计使然，见 plan §2.1 与风险登记。
- **`ClampedConfidence` / `ClampedScore` 的 preprocess**：clamp + 字符串数字兼容是有意行为，preprocess 是合适载体，非绕法。

## 更根本的一层（另立议题，本次不做）

现在有 **两套枚举清单**：schema 里一套（`ACTION_VALUES` 等）、`validatePlanningAgentPlan` 里又一套。subtask 枚举之所以在 schema 里 `z.unknown()` 透传、再由 validator 拒，是因为 **repair 信号目前只从 validator 出**。理论上可让 zod 自身产出 repair 信号（更严格的 schema 变体）消掉这份重复，但那要动校验架构，与"只 simplify、不改 validator"的边界冲突，需单独立项评估。
