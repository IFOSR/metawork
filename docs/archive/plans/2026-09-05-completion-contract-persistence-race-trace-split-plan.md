# Completion Body Contract, Turn Persistence Race, and Conversation/Trace Split Plan

- Date: 2026-09-05 (night)
- Status: Delivered 2026-09-05 (night). Validation: tests/web +
  tests/management + tests/execution + tests/executor + tests/gateway
  687 green; kernel/session-focused 92 green; lint clean. ADR-0021 amended
  (completion body channel).
- Trigger: 2026-09-05 acceptance run — GPT-6 research task blocked with
  "execution result is quarantined by a safety boundary" despite the report
  being fully produced; its trajectory lost all execution detail after a
  conversation switch; detailed executor steps now render in both the
  conversation view and the trajectory, duplicating each other.

## Fix 1 — Completion body: one deterministic format, enforced at output time

### Root cause (verified from raw attempt output)

The executor completed the work: 29,119-line event stream, report file
written to the workspace (23,909 bytes), full report pasted in the
second-to-last assistant message (8,933 chars). But the **final** message
began directly with the completion marker — zero body before it.
`parseCompletion` requires non-empty body → `completion_malformed` →
deliverability `quarantined` → kernel `block_work` immediately
(control-kernel.ts:1391), bypassing the correction loop entirely. The
incident outcome was "no result" while a complete result sat in the
workspace.

The user directive: body/report determination must be a **clear formatted
contract enforced at output time** — no heuristics about which message to
pick.

### Design

**Contract (report delivery), stated once and enforced everywhere:**

```
final response = [Markdown 正文] + 恰好一个完成标记 + strict JSON trailer
trailer = { evidence: [...], noChangeReason: null|…, reportPath?: "…" }
```

Body resolution is a single deterministic order — exactly one source wins:

1. Non-empty Markdown before the marker → that is the body.
2. Else `reportPath` in the trailer JSON → must reference a **new** file in
   the executor output area (validated against the workspace delta) → the
   file's content is the body. The file doubles as the registered artifact
   (declaration-independent registration already shipped).
3. Else → `completion_malformed` — but now **correctable**: the existing
   response-only correction is metadata-only ("return exactly one trailer,
   no body"), which is precisely sufficient to supply `reportPath` for an
   already-written file. Correction prompt learns the `reportPath` field.

`quarantined` is removed from the empty-body path and stays reserved for
safety violations. Enforcement at output time: the attempt context's
completion-contract section states the shape explicitly — final response must
be self-contained (body + marker + trailer in ONE message) or declare
`reportPath`; splitting body and marker across messages is a contract
violation.

ADR touch: amendment note in ADR-0021/0032 (reportPath as the explicit
file-body channel; empty-body no longer quarantines).

### Tests

- RED: marker-first response + `reportPath` to a new workspace file →
  certified, body = file content; `reportPath` to a pre-existing/foreign file
  → violation; no body and no `reportPath` → correctable `completion_malformed`
  routed to correction (not quarantine); correction supplying `reportPath`
  completes the subtask end-to-end in the attempt-runner seam.

## Fix 2 — Web turn persistence race (trajectory loss on conversation switch)

### Verified facts

- The journal holds the complete turn (165 `executor_progress` events — the
  streaming fix works in production).
- The persisted catalog record for the turn: **0 traceEvents**, finalAnswer =
  dispatch announcement only, status `completed` (not `blocked`).
- Other conversations (including same-day runs) persist full traces.
- `appendTurn` appends blindly (no per-turn dedupe/upsert); only one record
  exists for the turn, so exactly one premature persist won the race and the
  correct terminal persist never replaced it.

### Approach

**As delivered** (reproduction test pinned two defects):
   - Reproduced in `tests/management/web-gateway-session-runtime.test.ts`
     ("conversation switch persistence"): a task terminating while the user
     is on another conversation persisted a wrong record.
   - Defect 1: `final_answer` unconditionally downgraded the terminal trace
     status (`blocked` → `completed`). Fixed: the answer never overrides a
     terminal trace status.
   - Defect 2: `persistedTurnIds` lockout + blind `appendTurn` meant the
     first (stub) record won forever. Fixed: terminal persist is an
     information-richness-gated upsert — `appendTurn` now replaces by turn
     id, and a re-persist only happens when it adds information (status
     change, more trace events, or a longer answer).

## Fix 3 — Restore the conversation/trajectory presentation split (Web)

### Problem

`ConversationTurn` embeds `ExecutionNarrative` — full phase-grouped step
lists. After the streaming fix these now contain every executor step, so the
conversation view duplicates the trajectory tab. This violates the agreed
split (2026-09-05, long-task visibility §2.0): **conversation = conclusions +
milestones + live health; trajectory = complete detail**.

### Design

- Conversation turn keeps: user input, final answer, artifact cards, a
  one-line status/milestone summary, and the live health badge
  (`LiveExecutionPanel` while running).
- `ExecutionNarrative`'s grouped step detail moves out of the conversation;
  the turn shows a "查看完整轨迹" affordance that switches to the trajectory
  tab scoped to that turn. `TrajectoryView` is unchanged.
- Feishu already complies (activity card summary + milestone one-liners); no
  change.

### Tests

- tests/web: conversation view renders no per-step executor detail; the
  trajectory affordance is present; trajectory still renders everything.

## Sequencing and validation

1. Fix 2 reproduction test (pins the race) → Fix 2 implementation.
2. Fix 1 (completion protocol + correction + prompt contract + ADR note).
3. Fix 3 (Web presentation split).
4. Focused suites + lint; redeploy; user-perspective acceptance: research
   task shows streaming trajectory, conversation stays clean, report file
   previewable, no quarantine block when the report file exists.
