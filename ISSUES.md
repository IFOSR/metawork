# 待解决 Issues(临时移交)

> 来源:`main` 合并后的全面 code review + Docker 测试(2026-06-30)。
> 本文件为临时清单,供后续 agent 接手。已处理项不在此列(门禁 i18n 已修复,门禁单任务策略已在 ADR-0011 / CONTEXT.md 记录为刻意决策)。

## P1 — 5 个多任务验收用例已 `it.skip`,待多任务恢复时取消 skip

`TaskAdmissionGate`(刻意加入,见 [ADR-0011](docs/adr/0011-single-active-task-admission-gate.md))关闭了"第二个顶层任务"的排队/抢占/自动恢复。以下沿用旧多任务行为的验收用例已**保留但 `it.skip`**(每处带中文注释),避免阻塞当前推送:

- `tests/tui/auto-resume-preempted.test.ts` — "resumes the preempted parked task before a later normal queued task"
- `tests/tui/guidance-blocks.test.ts` — "shows a completion guidance block that points to the next queued task"
- `tests/tui/guidance-panel.test.ts` — "updates the guidance panel after task completion points to the next queued task"
- `tests/tui/memory-resume-acceptance.test.ts` — "keeps task-local memory ahead of global memory when a parked task resumes after preemption"

**处理方向**:当多任务调度重新启用时(放松门禁,放行调度器内部的恢复/抢占路径),搜索 `it.skip(` + "ADR-0011" 注释,逐个取消 skip 并按新语义修正。

复现:
```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test bash -lc "npx vitest run"
```

> 注:原先两条 P2(`execution-policy-planner` 路由置信度硬编码、`executor-routing-coordinator` 半角文案)已随旧路由/意图子系统整体删除而消失(见 `docs/tech-debt/legacy-compat-layers.md`,已关闭),故移除。

## P3 — LlmBridge 内联 per-executor 参数分支(抽象高度)

[`src/core/llm-bridge.ts:83`](src/core/llm-bridge.ts#L83) `buildCommandArgs` 用 `if (this.command === 'pi')` 硬编码 pi 专属 flags,与 codex 分支(`:79`)、默认分支并列。每加一个推理执行器都要改 LlmBridge。
**处理方向**:下沉到 adapter 层(参照 `buildCodexNonInteractiveArgs`),而非塞进 LLM 桥。

## P3 — `unique()` 重复实现

`unique()` 在多处各写一遍且 `filter(Boolean)` 行为略有差异(旧路由层的两处已随删除消失,剩余仍在):
- [`src/execution/execution-runtime.ts`](src/execution/execution-runtime.ts)
- `src/execution/work-graph-runtime-service.ts`

**处理方向**:抽到 `src/utils/` 单一实现并替换调用方。

---

### 已确认无需处理(review 中排除的误报)
- `docker/pi.env` 含真实 key 但已被 `.gitignore`/`.dockerignore` 忽略且未被 git 跟踪,不会推送;被跟踪代码里唯一 `sk-` 为测试假数据。
- 模块重组(`src/core/*` → 分模块):`tsc --noEmit` 通过,无悬空 import,无残留 `race_executors` / 旧 `capabilityClass` 字段读取方。
