# Feishu Presentation & Notification Overhaul Plan

- Date: 2026-09-06
- Status: Delivered 2026-09-06. Validation: 107 test files / 682 tests
  green (gateway, integrations, execution, management, web, Feishu E2E),
  lint clean. Web presentation untouched (management/web suites unchanged
  and green).
- Trigger: after the Web side stabilized, the Feishu side floods the chat:
  during a task the bot sent **10–12 cards per minute** (gateway audit log,
  2026-09-05 11:45–11:49 local), i.e. a new message every ~5 s. Users get a
  notification storm instead of one quiet activity card.
- Hard constraint: **no behavioral change to the Web surfaces.** Shared core
  logic (`task-activity-tracker`) may only gain Feishu-facing options.
- Scope addition (user, 2026-09-06): reports must be readable **inside Feishu
  as cloud documents** — a bare link or file path is not acceptable. This was
  requested before and never visibly delivered; root cause analysis in §1.1.

## 1. Diagnosis (evidence-backed)

The in-place card update path is not engaging in production; every repaint
falls back to a fresh message:

- The 5 s cadence matches `activityCardMinIntervalMs` exactly.
- Feishu message *edits* never notify; new messages do. The observed
  notification storm is therefore new messages, not edits.
- Prime suspect: the message-update API call is rejected (missing scope such
  as `im:message:update`, or card-update restrictions) and
  `upsertMarkdownCardToFeishuTarget` silently falls back to sending a new
  card — **every 5 seconds, forever**.
- Observability gap confirmed: update failures leave no audit record and no
  system message; card sends are audited as `kind: 'final'` regardless of
  actual purpose, so the flood was invisible in telemetry.

## 1.1 Why reports never became cloud docs (root cause)

The cloud-doc pipeline **exists and was verified**
(`importFileToCloudDoc` + `sendArtifactFilesToFeishu`: text artifacts → Feishu
docs, everything else → file message). It never fired for research reports
because its trigger is **answer-text parsing** — `extractArtifactPaths`
scans the answer for absolute file paths that exist on disk:

- Research answers say "报告已保存至工作区文件 xxx.md" (relative path) → no
  match → no sync, no link, nothing. (Yesterday's Channels report.)
- A blocked task never delivers at all. (This morning's GPT-6 report.)
- Meanwhile the report was never even registered as an artifact before the
  declaration-independent fix (shipped 2026-09-05 night).

So: pipeline present, trigger broken. The fix is to drive cloud-doc delivery
from **registered artifacts** (durable `task_artifacts` records), not from
parsing answer text.

## 2. Target notification model (three channels)

| Channel | Content | Notification behavior | Cadence |
|---|---|---|---|
| Silent activity card (exactly one per task) | current subtask, one-line current step, heartbeat badge, step count, last 3 steps in a collapsed section | **in-place edit only — zero notifications** | repaint at most every 10 s (configurable) |
| Weak notices | high-value milestones only: subtask completed/failed, executor lost + recovery decision, blocked awaiting user | one short chat line per event (deduped) | a handful per task |
| Formal notice | final answer + artifact links / cloud doc | normal message | once per task |

Explicitly removed from chat: subtask-start notices, planner narration, step
streams, heartbeat "活跃" lines — all live only inside the silent card.

Degraded mode (when in-place edit is rejected): the card re-sends at most
once per 60 s **and** records an audit entry — never a 5 s flood.

## 3. Work items

### W1 — Diagnose and repair in-place updates (the flood fix)

- Record update failures with Feishu's error code/message in the audit log
  and as a system message (fail loud, never silent-fallback).
- Verify the app's message-update permission; document the required scopes in
  the Feishu setup flow (`server setup-feishu` prints the checklist).
- Degraded-mode throttle: fallback re-send interval 60 s (configurable via
  the same `activityCardMinIntervalMs` family, separate knob).

### W2 — Notification tiering in the gateway port

- Extend `task-activity-tracker` milestone classification with a tier field:
  `chat` (subtask completed/failed, heartbeat lost, recovery decision,
  blocked) vs `card-only` (subtask started, planner narration, everything
  else). Feishu-only consumers read the tier; Web never consumes it.
- The card becomes the single surface for card-only events.

### W3 — Activity card content revision (Feishu L4, completing the deferral)

- Default render: one status line (当前子任务 + 当前步骤一句话 + 心跳徽标 +
  已完成 N 步).
- Detail: card 2.0 `collapsible_panel` with the last 5 steps; older steps
  available via the cloud-doc activity log link (existing pipeline) when
  configured.
- Final state: on task completion the card edits itself to a compact
  "✅ 已完成（用时 X）" summary — the card becomes a receipt, not debris.

### W3.5 — Reports as Feishu cloud documents (deterministic, artifact-driven)

Replace text-parsing triggers with durable records:

1. On final delivery (both the request path and the background/live delivery
   path), read the task's **registered artifacts** (`task_artifacts`).
   Every text/markdown artifact → Feishu cloud doc via the existing
   `importFileToCloudDoc`; binary artifacts → file message as today.
2. Report-delivery tasks whose body never became a file: create a cloud doc
   from the delivered body itself, so the report is always readable natively.
3. The final answer card carries the doc link(s) prominently ("📄 在飞书文档中
   阅读完整报告") — no separate fragile notice message.
4. Doc creation is labeled in audit (`cloud_doc`) and failures fall back to a
   file attachment with a loud system message.
5. Permission: docx import scopes join the W1 setup checklist.

### W4 — Purpose-labeled audit

- Audit kinds: `progress_card_update`, `progress_card_fallback`,
  `milestone`, `final`. Notification volume becomes measurable per task.

### W5 — Feishu regression gate

- New focused tests: tiering, fallback throttle, audit labels, card content
  shape (including collapsible section), one-card-per-task invariant.
- Existing Web suites must stay green untouched (management/web/e2e), proving
  zero Web impact.

## 4. Validation

1. Unit + integration suites green; lint clean.
2. Live acceptance: run one real research task via Feishu and count chat
   messages: exactly 1 card (self-editing) + ≤ a few milestone lines + 1
   final answer. No per-seconds notifications.
3. The final answer of a report task includes a Feishu cloud doc link that
   opens the full report natively in Feishu — verified by clicking it.

## 5. Estimate

| Item | Estimate |
|---|---|
| W1 diagnosis + loud failure + fallback throttle | ~0.5 day |
| W2 tiering | ~0.3 day |
| W3 card revision (collapsible + receipt state) | ~0.5 day |
| W3.5 artifact-driven cloud docs | ~0.5 day |
| W4 audit labels | ~0.2 day |
| W5 gates + live acceptance | ~0.3 day |
