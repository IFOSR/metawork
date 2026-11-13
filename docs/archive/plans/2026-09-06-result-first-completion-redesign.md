# Result-First Completion: Completion & Delivery Architecture Redesign

- Date: 2026-09-06
- Status: Approved & finalized 2026-09-06 (user-refined gate model below);
  ADR-0037 candidate. Implementation in progress.
- Preceded by: ADR-0021 (Work Graph v4 contract), ADR-0032 (result-first
  delivery amendment). This proposal consolidates and extends them into
  ADR-0037 (candidate).

## 1. Why reports keep dying: one architecture disease, five symptoms

Production evidence from 2026-09-04/05 (all verified against durable records):

| # | Incident | Surface symptom | Actual state of the result |
|---|---|---|---|
| 1 | Channels report (09-04 17:39) | delivered, but file not previewable | complete file in workspace |
| 2 | GPT-6 report (09-05 09:14) | **blocked**: "quarantined" | complete 24KB report in workspace |
| 3 | NFP/gold report (09-05 11:46) | delivered text, no artifact/doc | complete 20KB file; correction succeeded but skipped publication |
| 4 | Meat-industry plan (09-05 20:25) | **blocked**: "correction exhausted" | complete 49KB file; correction blind-failed on trivia |
| 5 | Channels follow-up (09-05 18:54) | **blocked**: missing handoff | source result complete and safe |

Root cause — the completion protocol conflates **three concerns into one
synchronous gate at the most fragile point in the system** (free-text LLM
trailer parsing):

1. the **business result** (already durable: workspace files + raw stream),
2. **metadata annotations** (evidence, noChangeReason, declarations),
3. **authorization & integrity** (containment, safety).

When the trailer is malformed, everything downstream — delivery, artifact
registration, handoffs, publication — dies together, even though (1) and (3)
are independently provable from runtime-owned facts. Two days of patches
(marker fixes, correction loop, reportPath, declaration-independent
materialization) fixed symptoms; the coupling itself remains.

## 2. Design principles

1. **产出即事实（Runtime facts are authoritative).** Workspace delta, raw
   event stream, and result objects prove what was produced. The trailer is
   an annotation channel, never a gate.
2. **安全永不降级（Safety stays fail-closed).** Containment/safety
   violations quarantine exactly as today. This redesign changes nothing
   there.
3. **安全的产出永远交付（A safe result always reaches the user).** Metadata
   quality affects certification, never deliverability. No trivia-blocked
   reports, ever again.
4. **校验对象是内容，不是格式（Checks target content correctness, never
   format).** Final gate model (user-approved):
   - 安全（内容越界/敏感/逃逸）→ 隔离（fail-closed）；
   - 执行器自认失败 → 任务失败；
   - 内容正确性（验收/身份/验审链）不过 → **block：不给下游消费**，但
     结果照样交付给用户并标注"未通过内容校验"；
   - 格式（marker/trailer/evidence/reportPath 等）→ 永不阻塞，仅 warning。
   There is no "uncertified → graph block" middle state for format trivia:
   format-clean results flow downstream immediately; content-failed results
   hold downstream while the user still receives them.

## 3. Target architecture: two independent lanes

```
attempt settles
   │
   ▼
┌─ Delivery lane (always runs) ─────────────────────────────┐
│ body = markdown-before-marker                              │
│      | reportPath → validated workspace file (shipped)     │
│      | single new report file in output area (delta-backed)│
│ safety gate (fail-closed, unchanged) ──► quarantine        │
│ deliver body + register artifacts + Feishu cloud doc        │
└────────────────────────────────────────────────────────────┘
   │
   ▼
┌─ Certification lane (best-effort, async) ─────────────────┐
│ trailer parsed strictly → evidence/acceptance/handoffs      │
│ malformed/missing trailer ──► correction loop (w/ workspace │
│   facts injected) ──► certified? release downstream edges   │
│ correction unavailable/exhausted ──► task stays blocked for │
│   explicit user resolution, **but the user already has it** │
└────────────────────────────────────────────────────────────┘
```

Concern ownership after redesign:

| Concern | Authority | Trailer role |
|---|---|---|
| body/content | runtime facts (delta, file) | hint (`reportPath`) |
| artifacts | workspace delta (shipped) | none (hint only) |
| handoffs | graph edges (shipped) | none (hint only) |
| evidence/acceptance | trailer, when parseable | best-effort annotation |
| failure declaration | trailer, when parseable | honored |
| safety/containment | runtime validation | n/a (fail-closed) |

## 4. Concrete changes

### R1 — Tolerant, normalized trailer parsing (mechanical)

- Accept the bundled form `<!-- metaclaw:completion:v4 {…json…} -->`
  (normalize to marker + JSON) — a recurring natural model variant.
- Tolerate trailing garbage after the JSON object (parse the first complete
  object).
- All normalization outputs still pass full strict validation.

### R2 — Schema relaxation (semantic, small)

- `evidence` may be empty (honest "nothing to cite"); acceptance validation
  still enforces evidence where acceptance keys require it.
- `reportPath: null` normalizes to absent.

### R3 — Delivery/certification decoupling (the core change)

- `deliverability` becomes a pure function of **safety + result existence**
  (body or file-backed result). Metadata violations never quarantine.
- Uncertified-but-deliverable results deliver immediately, labeled
  "已交付（未完成元数据认证）"; the subtask stays uncertified and the task
  remains blocked **for graph purposes**, with downstream edges held.
- Kernel rule change (ADR-0037): on `correction unavailable/exhausted`,
  if a safe deliverable result exists → deliver-as-partial + block-for-graph
  (explicit user resolution), instead of block-and-withhold.

### R4 — Correction with open eyes (mechanical)

- Correction prompt gains workspace facts: produced-file list (paths, sizes),
  source-body presence, `reportPath` usage guidance.
- The correction model can then truthfully declare `reportPath` instead of
  hallucinating "no report file was written" (meat-incident evidence).

### R5 — Simplified output contract prompt (mechanical)

- The attempt contract states the relaxed-but-explicit format: self-contained
  final response **or** `reportPath`; marker placement rules with the two
  accepted forms; "never split across messages".

### R6 — Anti-regression invariant (tests)

- New e2e invariant: **a task whose trailer is malformed in every
  previously-seen way still delivers its report** (Web artifact preview +
  Feishu cloud doc) while the task remains flagged for explicit resolution.
- Existing certification/correction/safety suites stay green.

## 5. Interaction with shipped work

Builds on, does not revert: declaration-independent artifact registration
(δ-driven), edge-authoritative handoffs, `reportPath` body channel,
correction-loop metadata repair, the Feishu notification overhaul, and the
Web presentation split. R3 replaces the *gating semantics* of ADR-0032's
amendment (partial+uncertified delivery becomes the default for safe
results, not an unused theoretical path).

## 6. Migration & recovery

- No schema migration: all changes are evaluation/dispatch semantics.
- Currently blocked tasks with safe results (GPT-6, meat plan): after
  rollout, `/task resume` re-evaluates → result delivers as partial +
  artifacts register + cloud doc attaches. One-off manual recovery is also
  available on request.

## 7. Rollout

1. R1+R2+R4+R5 (parser, schema, correction facts, prompts) — ~1 day.
2. R3 (kernel dispatch semantics + partial delivery + artifact/doc delivery
   on the uncertified path) — ~1 day, includes ADR-0037.
3. R6 invariants + full regression + live acceptance — ~0.5 day.

## 8. Post-delivery incident (2026-09-06, tracked separately)

During live E2E acceptance, newly submitted tasks stop dispatching after
authorize_task_plan is applied (observation null — verified to be the normal
design; dispatch is driven by the periodic task-pool review). The review timer
produces no further kernel decisions at all after the first blocked task in a
server session. Rollback experiment (disabling deliverSafeResultOnBlock) did
not restore dispatch, so this is a pre-existing admission/timer-path defect
unrelated to this redesign — all suites (134 files / 856 tests) stay green.
Reproduction data: tasks `…a704c8a7…` (low-altitude) and `…5543ef7c…` (AI
coding assistants) stuck in `created` with authorize applied; work unit
`executor-pi-research-int_YmLad4AbMw` heartbeat_lost during startup recovery.
Next step: instrument `reviewTaskPoolOnTimer` to find where the periodic
review silently stops.
