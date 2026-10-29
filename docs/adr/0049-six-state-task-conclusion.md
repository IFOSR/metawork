# ADR-0049: One Six-State Task Conclusion

- Status: Accepted
- Date: 2026-10-22
- Scope: Task Domain, Control Kernel, Execution Runtime, Gateway clients, persistence
- Amends: [ADR-0020](0020-core-module-ownership-and-dependency-direction.md) (Task Domain seam),
  [ADR-0022](0022-unified-kernel-control-plane-and-decision-ledger.md) (Task facts in Kernel snapshots),
  [ADR-0023](0023-durable-kernel-workflow-recovery-and-availability.md) (application postconditions),
  [ADR-0032](0032-result-first-delivery-and-completion-certification.md) (acceptance is a decision, not a bypass),
  [ADR-0037](0037-multi-conversation-task-parallelism.md) (slot release vs. Task conclusion)
- Supersedes: the raw-status mapping, `userState` projection and second Task transition table introduced by the 2026-09-25 lifecycle convergence plan

## Context

Task state had three near-duplicates: the persisted raw column
(`created/ready/running/parked/blocked/done/archived/cancelled`), a canonical
lifecycle vocabulary (`queued/executing/coordinating/waiting_for_user/blocked/
completed/failed/cancelled`) and a four-state user projection
(`waiting/executing/needs_action/finished`). Two transition tables disagreed,
`done` had no `failed` sibling, and several Runtime branches picked a Task status
from strings or from a single local fact. The same Task could therefore be
"done" in storage, "executing" in the TUI and "needs_action" in the Web client.

At the same time, the product needed one answer to a single user question:
"can this work continue, does it need me, or is it over?".

## Decision

### 1. Task persists exactly six states

```ts
type TaskStatus =
  | 'queued'       // 排队：已准备继续，等待执行名额
  | 'running'      // 执行中：系统正在做事或有有界自动恢复
  | 'needs_action' // 待处理：必须由用户处理，系统不会自动继续
  | 'succeeded'    // 成功：用户要求的必需工作全部完成
  | 'failed'       // 失败：必需工作确定失败且本轮不再自动尝试
  | 'cancelled';   // 取消：用户终止了任务
```

`TaskStatus` is owned by the Task Domain (`src/task/task-state.ts`) and
re-exported by `src/core/types.ts`. Consumers do not copy the vocabulary.
Subtask, Attempt, service, lease and Kernel application states remain their own
operational facts; they report evidence and never invent a Task conclusion.

Phase, reason code, pending actions and cleanup summary live in the bounded
`state_detail_json`. Archiving is an `archived_at` attribute, not a status.
`retry_of_task_id` links a follow-up Task that continues unfinished requirements;
the original Task keeps its conclusion.

### 2. Exactly one transition table

| From | Allowed to |
| --- | --- |
| `queued` | `running`, `needs_action`, `failed`, `cancelled` |
| `running` | `queued`, `needs_action`, `succeeded`, `failed`, `cancelled` |
| `needs_action` | `queued`, `cancelled` |
| `succeeded`, `failed`, `cancelled` | none (terminal) |

Same-state submission records reason/cleanup updates without a new conclusion.
`running -> queued` is the "only waiting for capacity" edge. A terminal Task never
revives; explicit retry creates a linked follow-up Task.

### 3. Exactly one summary function

`evaluateTaskState(facts)` in `src/task/task-state.ts` is pure and total. Its
order is fixed: terminal → cancellation fence → active operation / bounded
retry / held-slot runnable work → definitively failed required work → pending
user action → all required work complete → capacity-only queue → explicit system
anomaly (never a default `running`).

The Kernel authorizes execution, acceptance, retry and cancellation. Runtime
handlers report operation facts and ask the Task state authority to call the pure
summary and reconcile; Gateway, recovery workers and service
managers never derive a Task status themselves.

### 4. Exactly one durable write entry

`TaskLifecyclePort.applyTaskChange()` is the only writer of
`tasks.status`, `state_version`, `state_detail_json` and `completed_at`. In one
database transaction it resolves the operation key (idempotent replay), validates
the Decision identity, the expected version, the active graph and the
cancellation fence, applies narrowly scoped local facts, writes the new state
plus a `task_state_changes` row, and appends a durable projection notification.
For result acceptance/retry and remaining-work Task creation, the Kernel
application record and its durable continuation are committed in that same
transaction. Other application families retain their declared postcondition
recovery protocols. External process/Git/filesystem effects are never inside that
transaction.

`TaskRepo.update()` cannot carry lifecycle fields. `TaskStateAuthority` applies
one real transition; it never synthesizes intermediate states. A passive
observation cannot resume a Task awaiting user action. Explicit result acceptance
records the exact identity, then waits for a fresh Conversation reservation before
Git or publication effects.

### 5. Completion follows the authorized requirements

`work_graph_revisions.completion_requirements_json` records the requirement
snapshot authorized with that revision (execution per node, public file delivery,
safety report, required local service). A re-plan persists a new snapshot.
Evidence is durable: certified or explicitly accepted results, publication and
delivery checkpoints, service health plus manager handover. A Subtask label alone
is never completion evidence.

### 6. Safe release is not task state

Residue (`dispatch`, `publication`, `execution_backend`, `work_unit`,
`resource_lease`, `generation_replan`, `retry_wake`, `kernel_application`,
`attempt_receipt`) decides when a slot may be released. A required service that is
not healthy is a business outcome, not physical residue. A terminal conclusion is
recorded first; cleanup and `recovery_blocked` are reported separately.

## Consequences

- Every surface reads `TaskStateSnapshot { status, stateVersion, reason, phase,
  pendingActions, cleanup, nextWakeAt }`; Gateway `task_view_v2` carries it.
- Raw-status mapping helpers, `deriveTaskLifecycleState()`, the second Task
  transition table and `task-user-state.ts` are deleted.
- A Task in `needs_action` re-enters the queue through explicit acceptance or
  resume, and only an admitted dispatch makes it `running`.
- Migration classifies every legacy Task from durable evidence; a Task whose
  conclusion cannot be proven enters `needs_action` with the audit preserved.
- Recovery, retries and cancellation share the same table and the same entry, so
  replay cannot duplicate effects or revive a terminal Task.

## Review closure (2026-10-22)

A reservation has a unique token and monotonic slot version. Release rechecks
residue inside the SQLite transaction and can require both the captured Task
version and reservation version. Acceptance effects validate the active graph
and reservation before and after Git work. Task state outbox rows transfer
atomically into the existing conversation activity dirty queue.

Definite delivery/service failures keep the original Task failed. `/task retry`
creates a linked Task with only outstanding delivery/service requirements, using
immutable integrated publications and verified public files. Work without reusable
integrated outputs requires replanning rather than guessing that it is safe to
repeat. Explicit operations on an already handed-over service do not revive its
succeeded owner.

Schema 51 migration records immutable classification evidence and quarantines
unapplied legacy non-cancellation events/applications for inspection and new
authorization. Both Web and TUI require `task_view_v2`; lower Task versions cannot
replace a newer conclusion. See the [fix and validation record](../plans/2026-10-22-task-state-review-fixes.md)
for tested boundaries and deployment limitations.

## Amendment (2026-10-28): one user-facing status vocabulary

The decision above governs persistence and derivation, but clients still shipped
their own status words for the same Task (Web card `已完成/等待启动/已阻塞/
状态待确认`, graph nodes `待执行`, turn labels `已完成`, timeline stages
`进行中/完成`). A settled Task could therefore read "已完成" in one place and
"正在校验" in another, because one surface read the Task conclusion while the
other collapsed an internal Attempt/trace status.

Rules now enforced by the client contract:

1. **Only the six labels are user-facing task status.** Every surface that names a
   Task's status renders `TASK_STATUS_LABELS` from the durable TaskView /
   `ExecutionTimeline.status` (Web keeps a mirrored module plus a parity test).
   No client re-derives or renames a Task status.
2. **Internal states are not status.** Dispatch status, `terminal_disposition`,
   Attempt/runtime facts, receipt terminal states, Subtask lifecycle, work-graph
   node state and trace/stage state may select *progress text* and *visual
   encoding* (`data-state`), but they are never rendered as a status label or a
   status chip. Execution cards therefore carry no per-card status chip.
3. **A Turn without a Task is not a Task status.** A planner-only Turn names its
   phase ("已完成规划，未启动执行"); it never borrows a Task conclusion.
4. **Progress text must be true at the moment it is read.** Terminal facts may not
   be narrated in the present progressive ("正在校验…"), a yielded Attempt may not
   claim the Executor started, and missing timestamps show no duration.

## Amendment (2026-10-28): completion evidence is per result, not per newest attempt

The transition table and the evidence rules assume "the latest attempt describes
the node". That is wrong for a metadata correction: a completion-correction
attempt repairs certification metadata only, produces no new result, and can fail
after the result was already accepted or certified. Two consequences were
observed in production:

1. A failed correction hid the safe result from the acceptance surface
   (`readPendingTaskResults` supersession and the pending-decision projection).
2. It also erased the completion evidence: `execution`/`delivery`/`safety_report`
   requirements looked only at the newest receipt, so a Task whose result was
   accepted stayed `needs_action` with no pending action — a dead end.

Rules now enforced:

- Completion evidence is an accepted or certified receipt **of this generation**,
  independent of newer failed corrections.
- A `needs_action` block whose reason is system-caused (`no_authorized_driver`,
  `system_anomaly`) and whose evaluation now proves every required item complete
  with zero pending actions is corrected to `succeeded`. This is the only
  addition to the transition table (`needs_action -> succeeded`) and it is
  guarded twice: `TaskStateAuthority` only proposes it for a system reason, and
  `TaskLifecycleTransitionPort` rejects the write when the new detail still has
  pending actions. A user-facing block (accept, retry, input) can never be
  overridden this way.
- Recovery re-evaluates a `needs_action` Task once per pass, so a stale system
  block converges from durable facts instead of waiting for the user to resume
  work that is already done.
