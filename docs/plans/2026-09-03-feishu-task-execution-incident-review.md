# Feishu Task Execution Incident Review and Remediation Plan

- Date: 2026-09-03 (evening session)
- Status: P0/P1/P2 remediation delivered (2026-09-04); see §4 delivery notes
- Scope: end-to-end "明天上海/北京天气" task over the Feishu bot, exposing the
  execution chain's robustness gaps in a real development workspace.

## 1. Context

The Feishu integration was wired up earlier the same evening
(`metawork server setup-feishu`, schema/projection/wizard activation, CLI
pairing commands). The first real task through the Feishu surface then hit a
chain of five distinct execution failures plus several operations hazards.
Each failure was diagnosed to a root cause; five were fixed in-session with
regression tests, the rest are catalogued below.

## 2. Incident timeline

| Time | Event | Root cause | Status |
|---|---|---|---|
| 14:37 | Attempt 1 fails `attempt_exception` (EINVAL) | `importPlainSource` Node `fs.promises.cp` aborts on the browser daemon's Unix socket `.agent-browser/default.sock` | **Fixed** (filter skips socket/FIFO + test) |
| 15:20 | Task appears "blocked", no execution | Planner correctly issued a clarification (single-active-task constraint vs the blocked legacy task); Feishu presentation made it look like a hang | UX gap (P2-12) |
| 15:30 | `/task clear all` | Cancel raced a dispatch 16 ms after it landed; the `pending_launch` dispatch item was never terminalized → scheduler busy-looped on `listPending` with no backoff: one core at 100%, event loop starved (Feishu unresponsive, Web 000), **recurred on every restart** | Data triaged; **code fix TODO (P0-1, P0-4)** |
| 15:30+ | New task queues forever ("当前任务执行完成后执行") | Cancel never released the conversation task slot (`conversation_task_slots.occupied`) | Data triaged; **code fix TODO (P0-2)** |
| 15:30+ | 29 zombie `task_schedule_entries` in `running` for long-finished tasks | Terminal transitions do not close schedule entries on all paths | Data triaged; **code fix TODO (P0-3)** |
| 16:03 | Attempt fails: `cp EINVAL — copy into a subdirectory of self` | Dispatch row had `attempt_payload_json = null` → workspacePath missing → sourceRoot fell back to the workspace-store root, which contains the import temp dir | Guard added (clear self-nesting error); **payload-null writer path TODO (P0-5)** |
| 16:08 | Attempt fails `ENOTEMPTY rmdir .git/objects` | `importPlainSource` cleanup `rm` had no retry; APFS flush timing on git objects | **Fixed** (`rm` maxRetries 5 / retryDelay 120 + swallow cleanup errors) |
| 16:19 | Attempt fails: `workspace checkpoint rejects symlink: .venv/bin/python` | Real workspace contains a Python virtualenv; checkpoint/seed/container-prep hard-rejected symlinks | **Fixed** (uniform skip semantics; `.venv` added to exclusion lists + 2 tests) |
| (ops) | Server "vanished" repeatedly | Foreground server started from an assistant shell session; session cleanup killed it. `server restart` blocks waiting for the child to exit; stale `runtime.lock` after SIGKILL required manual removal | Ops/UX (P1-11, P0-6, P0-7) |

## 3. Fixed in-session (with regression tests)

1. **Socket-aware workspace import** — `managed-git-workspace.ts`
   `importPlainSource` copy filter skips sockets/FIFOs.
2. **Self-nesting import guard** — same function refuses a source that contains
   the import destination with a clear error instead of raw EINVAL.
3. **Cleanup retry** — import temp removal retries on transient ENOTEMPTY/EBUSY
   and never fails the attempt from cleanup.
4. **Symlink-tolerant workspace snapshot pipeline** — `workspace-store.ts`
   checkpoint scan, seed copy, and container-preparation now skip symlinks and
   non-regular files uniformly; `.venv` joined the exclusion lists
   (seed copy + plain-import top level).
5. **Feishu enablement fixes** (prerequisite work, not incident items): config
   schema `gateway.platforms.feishu`, projection passthrough, activation
   through ConfigurationService, `server setup-feishu` / `gateway pairing`
   CLI, `.env` loading at server start.

Validation: `tests/execution/` 34 files / 173 tests green (including the new
socket, cleanup-retry, and venv-symlink cases); local installation updated
and server restarted between fixes.

## 4. TODO list

### P0 — correctness bugs (must fix)

1. **Cancel cascade: terminalize `pending_launch` dispatch items.** —
   **Delivered.** Root cause refined: the 15:30 incident was an ordering race
   (cancel committed before the dispatch row landed), so `requestCancellation`
   never saw it. Fixed at both ends: `insertBatch` persists late arrivals
   directly as `cancelled` when the task/subtask fence is already terminal,
   and `claimPending` terminalizes fence-blocked items instead of returning
   null forever.
2. **Cancel cascade: release the conversation task slot.** — **Delivered.**
   `TaskCancellationCoordinator` now closes the schedule entry and releases
   the slot (with queued-task promotion) inside the cancel fence; new repo
   method `releaseTaskSlotAndPromote`.
3. **Terminal transitions close schedule entries.** — **Delivered** for the
   cancel path (2); all remaining paths are covered by the reconciler (8).
4. **Scheduler backstop: bounded retry/backoff for stuck dispatch items.** —
   **Delivered.** The busy loop was `AttemptSupervisor.drain` spinning on
   microtasks (`await Promise.resolve()`) while a fence-blocked item could
   never be claimed. drain now yields via macrotasks with backoff and fails
   loudly after a bounded idle budget (tunable, default ~60s); combined with
   the claim-time terminalization in (1) the drain converges.
5. **Dispatch payload integrity.** — **Delivered (2026-09-04).** Root cause
   refined again by the WeChat-Channels incident: normal dispatches obtain
   their workspace from the queued turn request (`QueuedExecutionRequest
   .workspacePath`), which the original submission carries; **recovery and
   timer requests are synthesized without it**, so continuation dispatches
   fell back to the workspace-store root and were stopped by the runner
   guard (`has no workspace source`) — correct defense, broken recovery.
   Fix: `KernelExecutionRuntime.runDispatchItem` now resolves the missing
   workspace through the new `resolveWorkspacePath(taskId)` dependency
   (task → `tasks.workspace_id` → workspace catalog → `canonicalPath`),
   wired from `server-composition` (and passed through the account service
   builders). Verified against real data: the Channels task resolves to
   `/Users/ylfego/Program/test` (available). Batch-dispatch payload
   synthesis (`selectDispatchableSubtasks`) remains payload-null by design;
   the runner-side workspace resolution makes that safe.
6. **Stale instance lock recovery.** — **Already present**
   (`acquireInstanceLock` reclaims stale locks by PID liveness); the 2026-09-03
   "lock stuck" observation was a live busy-looping process holding it. No
   code change needed; covered by (4) removing the busy loop.
7. **`server restart` must not block on child exit.** — **Delivered.**
   Restart spawns the server detached and waits (bounded, 90s) for the
   gateway socket to reappear.

### P1 — recovery, tooling, operations

8. **Kernel self-healing for half-cancelled states** — **Delivered** as
   `src/execution/task-state-reconciler.ts`: runs at server start, every 60s,
   and on demand; closes orphaned dispatch items, releases slots held by
   terminal tasks (blocked tasks keep theirs by design), terminalizes zombie
   schedule entries, and promotes queued tasks after slot release.
9. **`metawork doctor --deep`** — **Delivered**: `metawork server doctor` now
   reports dispatch-queue health (with orphan detection), stale conversation
   slots, zombie schedule entries, and blocked tasks, each pointing at the
   reconcile command when remediation is needed.
10. **Safe maintenance commands** — **Delivered**:
    `metawork maintenance reconcile-tasks` runs the reconciler on demand with
    a readable report (replaces the manual SQLite triage from the incident).
11. **Server supervision story** — **Delivered**: launchd plist and systemd
    unit templates under `scripts/supervision/` plus README sections (en/zh).

### P2 — experience

12. **Clarification presentation in Feishu** — **Delivered (copy level)**:
   the clarification entry now renders as "❓ 需要你回答（任务在此等待，不会自动
   继续）" with an explicit reply instruction and the `/task clear all` escape
   hatch. Interactive quick-reply cards need the Feishu card callback
   capability and remain future work.
13. **`/task clear` feedback** — **Delivered**: the result now confirms that
   conversation slots, the schedule queue, and dispatch were released.
14. **Human-readable failure reasons** — **Delivered**:
   `src/execution/failure-reasons.ts` maps the incident failure shapes
   (socket copy, symlink rejection, cleanup race, missing workspace source,
   timeouts, 401/429) to actionable Chinese hints surfaced as `failureHint`
   in executor settlement events.

### Test hardening (cross-cutting)

15. **Real-workspace fixture** — **Delivered** for the snapshot pipeline
    (venv symlinks, daemon sockets) in workspace-store and managed-git
    workspace tests.
16. **Cancel-race test** — **Delivered**:
    `tests/storage/kernel-dispatch-item-repo.test.ts` covers both race ends
    (persist-after-cancel and claim-after-cancel), and
    `tests/execution/attempt-supervisor.test.ts` asserts bounded drain on
    permanently unclaimable items.
17. **Event-loop liveness guard** — **Delivered at the unit level** (16);
    an end-to-end ping-under-stuck-item smoke remains future work alongside
    the CI automation.

## 5. Remediation plan

Delivered on 2026-09-04 per the delivery notes in §4: cancel cascades and
scheduler backstop (P0-1..4), payload defenses (P0-5 partial), restart fix
(P0-7), reconciler + doctor + maintenance command + supervision templates
(P1), experience copy (P2), and the race/liveness tests. Validation: full
suite 388 files / 1981 tests green, local installation updated, and the
reconciler observed closing state at server start.

Follow-up items outside this delivery:

- **P0-5 completion**: synthesize attempt payloads in batch dispatch
  (`control-kernel.ts` `selectDispatchableSubtasks`) so every dispatch carries
  its workspacePath/goal; requires Kernel decision-surface review.
- Feishu interactive quick-reply cards for clarifications (needs card
  callback configuration).
- CI automation for the packaged-release flow (per the Phase 2 plan) and an
  end-to-end cancel-storm smoke.

## 7. Post-remediation user-perspective test (2026-09-04, Web UI)

Executed through the Web client (http://127.0.0.1:8788, token login) as an
end user:

- **Case 1 — normal execution on the real workspace**: submitted a directory
  statistics task against `/Users/ylfego/Program/test` (which contains the
  exact artifacts behind incidents 1–7: `.venv` symlinks,
  `.agent-browser`, `.metaclaw`). Completed in ~50s through Planner →
  Kernel → codex-engineering → verification → publication with the correct
  answer; dispatch terminal, slot released, CPU 0% throughout.
- **Case 2 — cancel while executing**: submitted a longer task and sent
  `/task clear all` mid-execution.
- Idle-state `/task clear all` works and reports the new cascade-confirmation
copy.

Findings (recorded, not yet fixed):

- **Cancel commands queue behind the running turn.** A `/task` command sent
  while a task executes is queued like any input, with no queued indicator —
  to the user it looks ignored (the same shape as the "无反应" reports on
  Feishu). The Web UI has no dedicated cancel button either. Proposed fix:
  task-control commands (`/task`, `/clear`) should bypass the input queue and
  execute immediately, and the Web UI should surface a cancel affordance on
  the running task; tracked as P2 follow-up below.

- All manual SQLite triage tonight was performed against a backed-up database
  (`/tmp/metawork-db-backup-*.db`); the production fix must replace these
  edits with P0/P1 code paths.
- CPU diagnosis used Node Inspector sampling profiles
  (`listPending`/`rowToDispatchItem` hot loop) — keep that technique in the
  runbook.
