# 待解决 Issues(临时移交)

> 来源:`main` 合并后的全面 code review + Docker 测试(2026-06-30)。
> 本文件为临时清单,供后续 agent 接手。已处理项不在此列(门禁 i18n 已修复,单顶层 Task 策略已在 ADR-0011 / ADR-0026 / CONTEXT.md 记录为刻意决策)。

## Future — 4 个旧多任务验收用例保留为 `it.skip`

当前单 Task admission 由 `ControlKernel` 按 [ADR-0011](docs/adr/0011-single-active-task-admission-gate.md) 授权；旧 `TaskAdmissionGate` 已删除。[ADR-0026](docs/adr/0026-phase-6-single-task-reliability-closure.md) 明确多顶层 Task 不属于 Phase 6。以下依赖旧排队/抢占/自动恢复语义的用例保留为 `it.skip`，只在 [未来多 Task 路线图](docs/plans/future-multi-task-scheduling-roadmap.md) 被重新激活时重写：

- `tests/tui/auto-resume-preempted.test.ts` — "resumes the preempted parked task before a later normal queued task"
- `tests/tui/guidance-blocks.test.ts` — "shows a completion guidance block that points to the next queued task"
- `tests/tui/guidance-panel.test.ts` — "updates the guidance panel after task completion points to the next queued task"
- `tests/tui/memory-resume-acceptance.test.ts` — "keeps task-local memory ahead of global memory when a parked task resumes after preemption"

**处理方向**：未来若实现多 Task，不能原样恢复旧强抢占/自动恢复预期；应按新的协作式调度 ADR 重写，再移除对应 skip。该项不是 07-16 路线图或 Phase 6 的未完成验收。

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
