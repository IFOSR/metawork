# Multi-Conversation Parallel Task Design

> **Status:** Implemented on `parallel`; validation completed 2026-08-30
> **Branch:** `parallel`
> **Date:** 2026-08-29
> **Scope:** Multi-top-level-Task execution across Conversations, with strict Conversation context isolation

## Summary

MetaWork currently supports concurrent Subtask attempts inside one top-level
Task, but ADR-0011 still permits only one active top-level Task per
`AccountRuntime`. This proposal removes only that account-wide restriction and
replaces it with a Conversation-scoped execution slot:

- one Conversation may have at most one executing or cleaning-up top-level Task;
- a second Task from the same Conversation may be durably queued, but may not
  execute until the current Task releases the Conversation slot;
- different Conversations in the same Account may execute Tasks concurrently;
- all Tasks still share one account-level Kernel coordinator, global attempt
  capacity, resource lease system, publication gate and recovery authority;
- Planner history, Task evidence, permissions, execution workspaces and live
  detailed events remain isolated by their existing owner identities and are
  never merged merely because the Account or Workspace is shared.

Here, “Task” always means a top-level Task. The existing rule that independent
Subtasks inside one top-level Task may run concurrently remains unchanged. The
new rule is that two top-level Tasks owned by the same Conversation must never
have overlapping execution or cleanup lifetimes; top-level Tasks owned by
different Conversations may overlap subject to account capacity.

The proposal deliberately reuses the existing `decide(event, snapshot)`,
durable Kernel workflow, dispatch items, AttemptSupervisor, resource leases,
Task-generation worktrees, publication worker and origin-scoped Gateway. It
does not reintroduce the deleted `TaskAdmissionGate`, the old Scheduler, an
independent Runtime per Task, implicit preemption or a second strategic policy
chain.

## Review Decisions

The following decisions are accepted for the next implementation-plan revision:

1. **Same-Conversation behavior: persistent queue.** A Conversation may own
   multiple durable Tasks, but only one Task may occupy its execution slot at a
   time. A later Task is admitted as `queued` and is automatically eligible
   after the prior Task reaches a terminal state and releases its slot. Queue
   admission is bounded by `sameConversationQueueLimit`; exceeding that limit
   returns a structured rejection and does not create a partial Task.
2. **Parallelism is configurable through one user-facing control.** Settings
   exposes only “同时运行任务数”, backed by `maxConcurrentTasks`. Attempt,
   per-Task, aging, queue and idle-timeout controls remain validated internal
   runtime policy with safe defaults; they are not shown as ordinary product
   settings. Changes affect future scheduling rounds and do not cancel running
   Tasks or Attempts.
3. **Workspace directory shows bounded cross-Conversation summaries.** The
   Workspace directory displays that another Conversation has a queued or
   running Task, together with safe metadata such as Task title, status,
   owner Conversation display label, timestamps and bounded activity state.
   It does not display Planner transcript, user input, Task resources, evidence,
   permissions, detailed execution trace, raw output or result bodies. Opening
   details requires an explicit authorized Conversation attach and still keeps
   the Planner/context boundary intact.

Decision 3 is preferred over hiding all cross-Conversation activity because
parallel execution needs an understandable operational view. It is also safer
than exposing detailed events at Workspace scope: the directory answers “what
is running?” without answering “what did the other Conversation say or read?”.

Additional implementation decisions accepted on 2026-08-30:

- Selecting a Conversation attaches and replays it immediately. Web does not
  present a separate “继续此会话” activation button or an intermediate
  read-only Conversation view.
- Provider model discovery is required. After a Provider has a usable Base URL
  and credential, MetaWork queries its OpenAI-compatible model endpoint and
  merges discovered IDs with explicitly configured IDs. Discovery failure must
  retain configured IDs and produce bounded diagnostics without exposing the
  credential.
- Existing Tasks already left blocked by the pre-fix timeout-classification bug
  are not migrated or resumed. Local test data may be cleared explicitly;
  immutable historical receipts and Kernel ledger records are not rewritten.
- Provider concurrency is not treated as the cause of the observed failure and
  no Provider/model concurrency setting is added as part of this repair. The
  unknown Pi stream stall receives observability first.

## Proposed Invariants

### 1. Identity and ownership

Every admitted top-level Task has one immutable owner tuple:

```text
accountId       AccountRuntime / database boundary
conversationId  semantic and delivery owner
workspaceId     Workspace binding at admission
plannerSessionId Planner dialogue identity used for explicit Planner evidence
generationId    Work Graph generation
```

`conversationId` is the product ownership identity. `plannerSessionId` remains
the AnyFusion-Pi session identity and may be different in representation, but
the mapping is immutable for the lifetime of the Conversation. `sessionId` in
legacy Kernel records is not sufficient by itself for new ownership checks;
new durable records must carry `conversationId` explicitly.

Task ownership is immutable after the first accepted plan. A Conversation may
be attached from multiple clients, but all attachments see the same
Conversation-owned Planner history and Task execution projection. Sharing a
Workspace does not make two Conversations one context.

### 2. Conversation execution slot

The slot is a durable per-Conversation invariant, not an in-memory boolean.
The slot is occupied while a Task has any of the following:

- Task execution is `running`;
- an attempt is pending, launching, running, cancelling or uncertain;
- publication, resource lease, WorkUnit or cancellation cleanup is still
  active or uncertain;
- startup recovery has not proved that the previous Task released all of the
  above.

The slot is released only after the Task is terminal and the existing Phase 6
completion invariant reports no dispatch, publication, sandbox, WorkUnit,
resource-lease or recovery residue. A Task in `blocked` or `parked` state with
no active cleanup residue does not occupy an execution slot. It remains a
recoverable historical Task. A resume request changes neither the Task's owner
nor its generation; it makes the Task eligible only after the Kernel has
reacquired its Conversation slot. If another Task from that Conversation is
occupying the slot, the resume remains queued.

This produces the following behavior:

| Request | Existing Conversation Task | Result |
| --- | --- | --- |
| new executable Task | none executing | admit and schedule |
| new executable Task | one executing | persist as queued; do not dispatch |
| new executable Task | one executing in another Conversation | admit and schedule subject to account capacity |
| resume Task | same Conversation has another executing Task | queue the resume request; do not run in parallel |
| resume Task | another Conversation is executing | schedule if global capacity and resources permit |
| cancel Task | any Conversation | Kernel-authorized cancellation of only that Task |
| direct reply/status query | any Task state | allowed; it does not acquire an execution slot |

Same-Conversation queue admission is bounded by the configured
`sameConversationQueueLimit`. Queue entries preserve the owning Conversation,
Workspace and configuration-revision identity from admission; they do not
inherit newly selected Workspace or Planner context later. A queued Task may
only become runnable after its own Conversation slot is released and its own
Task/resource/revision facts remain valid.

### 3. Account-level capacity

Account-wide limits are separate from the Conversation slot:

- `maxConcurrentTasks`: maximum number of Tasks with an occupied execution
  slot that may receive attempts;
- `maxConcurrentAttempts`: existing global maximum number of active attempts;
- `maxConcurrentAttemptsPerTask`: per-Task cap, required to prevent one DAG
  from consuming every account attempt slot;
- resource and partition leases: existing conflict authority, evaluated across
  all Tasks rather than only the current Task.

The implementation uses these initial defaults and bounds:

| Policy | Default | Accepted range | Reason |
| --- | ---: | ---: | --- |
| `maxConcurrentTasks` | `2` | `1..8` | Allows parallel Conversations while bounding process/resource pressure |
| `maxConcurrentAttempts` | `4` | `1..32` | Account-wide attempt capacity; the current default remains unchanged |
| `maxConcurrentAttemptsPerTask` | `2` | `1..32` | Prevents one graph from consuming all account capacity |
| `schedulingAgingMs` | `300000` | `0..86400000` | Gives queued eligible work an aging signal after five minutes |
| `sameConversationQueueLimit` | `8` | `0..32` | Bounds queued Tasks per Conversation; `0` means no additional queued Task |

`maxConcurrentTasks` is the number of occupied Conversation slots whose Tasks
may be scheduled; it is not required to be less than or equal to
`maxConcurrentAttempts`, because a Task can occupy a slot while waiting for a
resource, recovery, publication cleanup or an attempt slot. The effective
number of simultaneously active attempts is bounded independently by the two
attempt limits.

All five values are configuration facts, validated at startup and never
silently clamped. `maxConcurrentAttemptsPerTask` must be no greater than
`maxConcurrentAttempts`. Existing configurations that omit the new fields use
the defaults above when projected; they do not require an environment-variable
migration. Lowering a limit never cancels running work and only affects later
scheduling rounds. `maxConcurrentTasks = 1` is a safe rollback configuration
for operators, but is not a semantic feature flag or a second scheduler.

## Architecture

### Target control flow

```text
Conversation A Planner turn ─┐
Conversation B Planner turn ─┼─> Account Kernel Coordinator
Task A / Task B facts       ┘          │
                                       v
                           ControlKernel.decide(event, snapshot)
                                       │
                         schedule/dispatch decisions
                                       │
                         Account Runtime applies effects
                                       │
             AttemptSupervisor launches isolated attempts
                                       │
              normalized facts return to the same Kernel
```

There remains one AccountRuntime, one durable Kernel writer and one decision
ledger per Account. Conversation sessions are not promoted to schedulers and
Tasks do not get their own Runtime. The Account coordinator serializes
authorization and application; the attempt supervisor remains asynchronous.

### Required correction to the current coordinator

The current `AccountKernelCoordinator` binds a mutable `buildSnapshot` and
mutable Runtime reference before each operation. That is safe only while
Conversation submissions are effectively serialized. With multiple Task
contexts, a later Conversation can overwrite those references while a prior
Task's durable event is still being applied.

The parallel design must replace that mechanism with immutable routing:

- `KernelEvent` carries `accountId` implicitly through the AccountRuntime and
  carries explicit `conversationId`, `taskId`, `subtaskId` and `attemptId`
  where applicable;
- snapshot construction is an AccountRuntime operation keyed by the event,
  not a callback captured from the last Conversation;
- Runtime application resolves the target Task/Conversation from the durable
  Decision and dispatch identity, not from `AsyncLocalStorage` state;
- presentation callbacks are routed by immutable Conversation ID and Task
  owner, never by a mutable “current session” binding;
- recovery uses the Conversation ID persisted on the original decision/event,
  so a disconnected client or a different active Conversation cannot steal the
  callback context.

`AccountConversationExecutionBinder` may remain as a compatibility adapter for
legacy Conversation-facing methods, but new background execution paths must
receive an explicit immutable execution binding. The dynamic
`currentSessionId()` fallback must not be used to identify a parallel Task.

## Planning and Conversation Semantics

### Planner process isolation

The existing AnyFusion-Pi process boundary is retained:

- each Conversation retains one stable Pi session file;
- turns within one Conversation remain serialized by the per-session Planner
  queue;
- turns in different Conversations may run concurrently in separate RPC
  processes/session queues;
- no Planner process receives another Conversation's transcript by default;
- the seven MetaWork MCP tools receive an explicit Conversation/Task scope;
- `get_current_session_context` reads only the current Conversation's durable
  interaction and proposal history.

The shared `AccountPlannerServices` object is only a process/service factory;
it must not hold mutable current Conversation state. A Planner process may
query account-level routing and executor availability, but those are bounded
facts and do not include another Conversation's user text, assistant output,
Task evidence or hidden reasoning.

### Plan admission rules

`plan_admission` must replace the current scalar `runningTaskId` with:

```ts
activeTaskByConversation: Record<string, string | null>;
queuedTaskCountByConversation: Record<string, number>;
occupiedConversationIds: string[];
```

For an initial `plan_work_graph`:

- `taskId = null` creates a new Task owned by the event Conversation;
- if that Conversation has no occupied slot, the Task is eligible for
  scheduling immediately;
- if that Conversation has an occupied slot, the Task is admitted as queued;
- a different Conversation's occupied slot is irrelevant to admission;
- an existing Task ID is accepted only when its immutable owner matches the
  event Conversation, unless a separately authorized administrative command
  explicitly requests cross-Conversation control.

For a `task_control` proposal:

- `status_query` may return bounded account/workspace summaries, but must not
  inject another Conversation's context into Planner history;
- `resume_task`, `recover_blocked` and `clear_tasks` require an explicit Task
  identity and owner authorization;
- an implicit “continue the other Conversation's Task” interpretation is
  rejected or clarified;
- a same-Conversation queued Task remains queued until the slot is free;
- no Planner action may directly select an Executor or bypass the scheduler.

### Context visibility policy

The Planner and Executor context contract is explicitly split:

| Context | Same Task | Same Conversation, other Task | Other Conversation, same Workspace | Other Account |
| --- | --- | --- | --- | --- |
| current user input | allowed | denied | denied | denied |
| Planner transcript | allowed only in owner Conversation | denied by default | denied | denied |
| Task evidence/resources | allowed by explicit `ContextRef` | denied | denied | denied |
| confirmed global preference | allowed when policy permits | allowed when policy permits | allowed when policy permits | denied by DB boundary |
| Task-local preference/memory | allowed | denied | denied | denied |
| direct dependency handoff | allowed only within same graph/generation | denied | denied | denied |
| Task status summary | owner/detail allowed | bounded summary only | bounded directory summary only | denied |
| Executor stdout/stderr/raw prompt | never exposed through Gateway/Planner | never | never | never |

An explicit cross-Conversation attach or management view may show bounded Task
metadata, but it does not merge Planner sessions, evidence catalogs or
execution context. Any future cross-Conversation handoff must be a new typed
Work Graph contract and cannot be inferred from shared Workspace paths.

## Kernel and Scheduling Contract

### New account scheduling event

Add an account-scoped event, tentatively named
`task_scheduling_requested`:

```ts
type TaskSchedulingRequested = KernelEventEnvelope & {
  type: 'task_scheduling_requested';
  reason: 'task_admitted' | 'attempt_finished' | 'publication_integrated'
    | 'capacity_changed' | 'resource_released' | 'timer' | 'startup_recovery';
  candidateTaskIds?: string[];
};
```

The event is a trigger, not a task-selection instruction. Runtime may submit it
after a durable admission, attempt terminal fact, publication integration or
lease release. The candidate list is an optimization hint only; Kernel must
rebuild and validate the authoritative candidate set from the snapshot.

### Scheduler snapshot

Add a `scheduler` snapshot variant containing bounded facts for every eligible
Task and Conversation:

```ts
interface KernelSchedulerSnapshot {
  schemaVersion: 6;
  type: 'scheduler';
  account: {
    maxConcurrentTasks: number;
    maxConcurrentAttempts: number;
    activeTaskCount: number;
    activeAttemptCount: number;
    freeTaskSlots: number;
    freeAttemptSlots: number;
  };
  conversations: Array<{
    conversationId: string;
    activeTaskId: string | null;
    slotState: 'free' | 'occupied' | 'releasing' | 'recovery_blocked';
    lastServedAt: string | null;
    fairnessSequence: number;
  }>;
  candidates: Array<{
    taskId: string;
    conversationId: string;
    workspaceId: string;
    status: 'created' | 'ready' | 'blocked' | 'parked' | 'running';
    eligibleSince: string;
    priority: 'normal' | 'high' | 'urgent';
    priorityReason: string;
    runnableSubtaskIds: string[];
    activeAttemptCount: number;
    perTaskAttemptLimit: number;
    resourceConflictSubtaskIds: string[];
    generationId: string;
    graphRevision: number;
  }>;
}
```

The snapshot must be bounded and deterministic. It may omit large Task text,
Planner transcripts and evidence bodies. Resource conflict facts are
canonicalized by the Resource Model before entering Kernel policy.

### New scheduling decision

Extend the existing dispatch seam with a grouped action, tentatively:

```ts
type ScheduleDispatchBatches = {
  type: 'schedule_dispatch_batches';
  reservations: Array<{
    taskId: string;
    conversationId: string;
    items: Array<DispatchItemAuthorization>;
    slotReservationId: string;
  }>;
};
```

Each inner item retains the current immutable attempt identity, binding
fingerprint, generation, attempt kind, recovery mode, resource grant and batch
order. The Runtime applies this decision by inserting the existing durable
`kernel_dispatch_items` rows and atomically reserving the corresponding
Conversation slots. The AttemptSupervisor still launches individual attempts;
the grouped decision only lets one pure Kernel decision choose work across
multiple Conversations without adding a scheduler-owned policy path.

If implementation complexity shows that grouped decisions create too much
ledger or recovery surface, the fallback is one `dispatch_batch` decision per
Task from repeated account-scoped scheduling events. The fallback must still
select each Task from the same all-Conversation snapshot and must not move
selection into Runtime.

### Selection policy

The initial policy is cooperative and non-preemptive:

1. filter Tasks whose Conversation slot is free, whose graph frontier is
   runnable, whose Task is not recovery-blocked and whose resources are
   grantable;
2. rank `urgent > high > normal` only when the Planner supplied a bounded
   reason and the validated Task priority is persisted;
3. apply aging to eligible Tasks that have waited beyond the configured aging
   interval;
4. break ties by Conversation fair-share sequence, then `eligibleSince`, then
   Task ID;
5. reserve at most one new Task per free Conversation slot in one scheduling
   round, unless all other candidates are blocked by resources;
6. allocate attempt capacity with a per-Task cap and leave capacity for the
   next eligible Conversation when possible;
7. never revoke an active attempt merely because a higher-priority Task arrives.

The policy has no forced preemption. Cancellation is explicit and
Kernel-authorized. A Task that cannot run because its Conversation slot is
occupied remains queued with a durable reason such as
`conversation_execution_slot_occupied`, not `blocked` unless a real Task
blocker exists.

The fairness cursor/sequence must be durable. An in-memory round-robin cursor
would reset on restart and could starve older Tasks. Priority and aging must be
computed from snapshot facts supplied to Kernel; Kernel may not read a clock.

## Persistence and Migration

The implementation should use a hard schema migration from the current schema
to a new version, with no long-term dual-read or dual-write path. The exact
version number is to be fixed after the current branch baseline is confirmed;
the proposal assumes the next release schema is `v35`.

### Task ownership fields

Add non-null immutable fields to `tasks`:

```text
conversation_id
workspace_id
owner_planner_session_id
admitted_at
```

Existing rows are migrated using the originating `kernel_decisions.session_id`
and the Conversation catalog/binding map. Ambiguous rows must fail startup and
be quarantined for explicit repair; they must not be assigned to an arbitrary
current Conversation.

### Kernel and execution identity

Add indexed `conversation_id` and, where applicable, `workspace_id` to:

- `kernel_events`;
- `kernel_decisions`;
- `kernel_decision_applications` if it has denormalized identity;
- `kernel_dispatch_items`;
- `executor_attempt_receipts`;
- `attempt_execution_backends`;
- `resource_leases` and resource waits;
- `workspace_records`/publication records where the schema has denormalized
  Task identity;
- Gateway/trace journal records that currently infer Conversation through
  `sessionId`.

The JSON payload remains the complete audit record, but indexed columns are
needed for ownership queries, recovery and cross-Task scheduling without
parsing arbitrary JSON.

### Durable scheduler records

Add:

```sql
CREATE TABLE conversation_task_slots (
  conversation_id TEXT PRIMARY KEY,
  active_task_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('free', 'occupied', 'releasing', 'recovery_blocked')),
  reservation_id TEXT,
  fairness_sequence INTEGER NOT NULL DEFAULT 0,
  last_served_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_task_id) REFERENCES tasks(id)
);

CREATE TABLE task_schedule_entries (
  task_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'eligible', 'reserved', 'running', 'terminal')),
  enqueued_at TEXT NOT NULL,
  eligible_since TEXT NOT NULL,
  last_scheduled_at TEXT,
  scheduling_reason TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

The slot table is the durable uniqueness fence for “one executing Task per
Conversation.” The schedule entry is not a second Task state machine; it is a
projection used to make queue/aging/fairness facts explicit. Kernel remains the
owner of whether a Task should be reserved, queued, blocked or resumed.

The `schedule_dispatch_batches` application transaction must:

1. verify every reservation still matches the event snapshot and immutable
   owner tuple;
2. atomically claim each free Conversation slot;
3. insert dispatch items with unique attempt IDs;
4. persist fairness sequence updates;
5. write Task/dispatch schedule facts;
6. enqueue any required follow-up scheduling event only after the durable
   application postcondition is complete.

A unique constraint or conditional update must reject two concurrent decisions
from reserving the same Conversation slot. The losing event is re-evaluated by
the account coordinator and must not launch an attempt.

### Existing single-Task fields

The following scalar fields must be removed from strategy and replaced by
scoped projections:

- `runningTaskId` in plan admission and dispatch policy;
- `getSingleActiveTaskId()`;
- account-wide assumptions that `listTasksByStatus('running')[0]` is the only
  execution owner;
- presentation text that reports exactly one running Task;
- configuration activation checks that inspect only one Task.

Compatibility method names may remain temporarily as presentation adapters only
if they return an explicitly documented local Conversation result. They must
not remain inputs to Kernel policy.

## Execution and Resource Isolation

### AttemptSupervisor

The current supervisor already has a global `active` map but stores execution
contexts by `taskId`. Parallel execution requires:

- context keyed by `attemptId` or an immutable dispatch binding;
- `activeCount(taskId)` and `activeCount()` both remain correct;
- `kick()` selects pending items across all eligible Tasks, not one Task at a
  time;
- selection order comes from durable scheduling decisions, not map insertion
  order;
- `drain(taskId)` drains only that Task for explicit cancellation/recovery;
- account shutdown drains all Tasks;
- a late completion is fenced by attempt ID, Task ID, generation, graph
  revision and dispatch status before any result/publication mutation.

The supervisor remains a side-effect runner. It must not decide priority,
fairness, fallback, retry, replan or cross-Task admission.

### Worktrees and publication

Every attempt continues to use the current Task-generation-Subtask managed
worktree. No Executor may read another Task's worktree, handoff directory,
attempt home or private session directory.

For two Tasks in the same Workspace:

- both may read the immutable source binding;
- each writes only its own managed Task worktree;
- each receives only its Task resources and direct graph handoffs;
- publication to the user-visible repository remains serialized;
- overlapping file changes are detected at publication and produce the
  existing conflict chain, never an implicit last-writer-wins merge;
- unrelated paths may integrate independently if the existing publication
  ordering and repository lock permit it.

The source repository or Workspace must be represented as a shared Resource
Model identity, while Task worktrees remain distinct identities. A default
claim such as `workspace-${taskId}-...` alone is not sufficient to detect
cross-Task conflicts on the same source repository or external object.

### Resource leases

Resource conflict lookup must become account-wide and include the owning
`taskId`, `conversationId`, `subtaskId` and `attemptId` in the normalized fact.
The Resource Model still owns only identity/overlap/conflict rules; Kernel
decides whether a candidate waits, and Runtime creates/releases the lease.

Resource waits must be scoped to the waiting Task and may name conflicting
lease IDs from another Task. A Task waiting on A's exclusive external object
must not block an unrelated Task B whose claims do not overlap.

Cross-Task access denials must be fail-closed even when paths are equal. A raw
filesystem path is not an authorization boundary; the lease/partition identity
and owning Task are.

## Recovery, Cancellation and Completion

### Startup recovery

Startup recovery changes from “scan running Tasks” to:

1. reconcile all attempt/backend records in the Account;
2. reconcile every `conversation_task_slots` row in `occupied`, `releasing` or
   `recovery_blocked` state;
3. reconcile dispatch items, WorkUnits, leases, publications and result
   delivery by Task identity;
4. submit normalized facts through the one Account Kernel coordinator;
5. release a Conversation slot only after its Task cleanup postcondition is
   durable and proven;
6. submit account-level scheduling after all safe candidates are known.

A broken Task must not accidentally release its Conversation slot and allow a
second Task from that Conversation to run. Conversely, a recovery failure
that is proven to be isolated to Task A should block A's slot and allow an
independent Task B from another Conversation to proceed. Database/schema
corruption or account-wide Kernel ledger uncertainty still blocks the account.

### Cancellation

`task_cancel_requested` retains Task identity and becomes explicitly scoped to
the owner Conversation or an authorized account management command. Kernel
returns a cancellation action for only that Task. Runtime enumerates only that
Task's active dispatch items, attempts, publications, WorkUnits and leases.

The cancellation coordinator must stop using “find the one cleanup Task” as an
account invariant. It must return a set/list of cleanup Tasks and keep each
Conversation slot occupied until its own cleanup is complete. A late outcome
from cancelled Task A cannot modify Task B, even if both use the same
Workspace.

### Completion

Task A becoming `done` releases only Conversation A's slot. It emits a durable
`task_slot_released` fact or schedules the next account scheduling pass. A
queued Task in Conversation A can then be selected, while Tasks in other
Conversations are unaffected.

No Task is considered complete while its own residue exists. Account-level
parallelism must not weaken the existing Phase 6 completion fence.

## Gateway, TUI and Web Behavior

### Event routing

Detailed events remain origin-scoped under ADR-0036. Add explicit
`conversationId` and `taskId` to every Task/execution projection where either
is currently inferred. A Task A event is live-delivered only to the turn origin
for Conversation A. It is replayable after authorized attach to Conversation
A, not broadcast to every Conversation in the Workspace.

Workspace directory events may expose bounded summaries such as Task title,
status, owner Conversation label, updated time and activity state. They must
not expose Planner transcript, Task resources, evidence bodies, raw execution
output or detailed trace from another Conversation.

### ConversationSession projection

`ConversationSession.refreshRuntimeState()` currently lists all Tasks and picks
the first `running` Task. It must instead query an owner-scoped projection:

```text
conversationTasks(conversationId)
conversationActiveTask(conversationId)
conversationQueuedTasks(conversationId)
```

Its local `runtimeState.runningTaskId`, executor names, guidance and output
must be based only on that Conversation's Tasks. Account/workspace summaries
are a separate bounded view and must not become Planner context.

The Web Trajectory/Execution view can show the selected Conversation's full
history. A workspace-level task directory can show other Task summaries and
offer an explicit attach/navigation action; navigation changes the selected
Conversation, not the ownership or Planner session of a Task.

The native TUI remains a client-only surface. It must not construct another
Runtime to follow Task B and must not use a global `runningTaskId` to suppress
input for a different Conversation.

### User-visible messages

Replace the current single-active wording with precise outcomes:

- same Conversation: “任务已加入当前会话队列；当前任务完成或释放后执行”；
- other Conversation capacity wait: “任务已接纳，等待账户执行资源”；
- resource conflict: “任务已接纳，等待资源 X 释放”；
- actual rejection: only for invalid plan, authorization, ownership or hard
  safety failures.

“Command completed” continues to mean command admission only; execution start
is reported only after the authoritative scheduling/dispatch Decision.

## Configuration and Operational Controls

Add a revision-pinned runtime policy object:

```ts
runtimePolicy: {
  maxConcurrentTasks: number;
  maxConcurrentAttempts: number;
  maxConcurrentAttemptsPerTask: number;
  schedulingAgingMs: number;
  sameConversationQueueLimit: number;
}
```

These fields must have a first-class system settings entry. The settings UI/API
should expose human-readable labels and current/effective values, for example:

| Setting | Recommended default | Meaning |
| --- | ---: | --- |
| `maxConcurrentTasks` | `2` | Maximum simultaneously executing top-level Tasks across Conversations |
| `maxConcurrentAttempts` | `4` | Existing account-wide active attempt limit |
| `maxConcurrentAttemptsPerTask` | `2` | Maximum attempts one Task can consume at once |
| `schedulingAgingMs` | `300000` | Wait time after which an eligible Task gains aging priority |
| `sameConversationQueueLimit` | `8` | Maximum queued, not-yet-running Tasks owned by one Conversation |

The settings surface must show a short explanation that lowering a limit does
not stop current work and takes effect on the next scheduling round. It should
also show effective account usage and a warning when a lower limit causes
queued Tasks to wait. Configuration completion must reject invalid values
before activation and preserve the existing immutable revision semantics.

Recommended initial validation:

- `maxConcurrentTasks`, `maxConcurrentAttempts`,
  `maxConcurrentAttemptsPerTask` and `sameConversationQueueLimit` are integers
  within the ranges in the table above; `sameConversationQueueLimit = 0` is
  valid and disables additional same-Conversation queue admission;
- `schedulingAgingMs` is an integer in `0..86400000`;
- `maxConcurrentAttemptsPerTask <= maxConcurrentAttempts`;
- invalid values fail startup;
- a configuration activation is rejected while existing Tasks/attempts would
  violate the revision switch invariant, following ADR-0033;
- existing generations retain their revision and binding; new queued Tasks
  use the activated revision when admitted.

Changing the concurrency limit must not cancel running attempts. Lower limits
apply to future scheduling rounds. Raising limits requires the normal
configuration activation gate and causes a scheduling request after activation.

Operational status should expose:

- active Task count and active Conversation count;
- per-Conversation occupied/free/releasing slot;
- queued Task count and queue age;
- per-Task active attempts and wait reason;
- global attempt usage and resource conflicts;
- recovery-blocked Tasks versus account-wide recovery block.

## Implementation Sequence

This is a proposed execution sequence, not authorization to begin coding.
Each step should be implemented TDD-first with a focused commit.

### Phase 0: Contract freeze and characterization

Files to inspect/characterize:

- `src/account/account-kernel-coordinator.ts`
- `src/account/account-runtime.ts`
- `src/account/account-startup-recovery-service.ts`
- `src/account/account-conversation-execution-binder.ts`
- `src/kernel/control-kernel.ts`
- `src/kernel/kernel-workflow.ts`
- `src/execution/kernel-execution-runtime.ts`
- `src/execution/attempt-supervisor.ts`
- `src/execution/task-cancellation-coordinator.ts`
- `src/session/conversation-session.ts`
- `src/planning/planner-mcp-server.ts`
- `src/execution/subtask-execution-context.ts`
- `src/work-graph/context-ref-eligibility.ts`
- `src/storage/migrations.ts`

Add characterization tests proving the current assumptions that must be
replaced: scalar `runningTaskId`, `tasks[0]` status projection, one Task in
startup recovery, mutable binder routing, per-Task supervisor context and
single-Task rejection.

### Phase 1: Identity and storage hard cut

Add `conversationId`/`workspaceId` ownership to Task and all durable execution
identity records, add slot and schedule repositories, and implement the
transactional schema migration. Add migration tests for clean databases,
valid legacy ownership reconstruction, ambiguous ownership refusal and
rollback after any failed table rebuild.

### Phase 2: Pure scheduler and Kernel decision contract

Create a Work Graph/Kernel-facing pure scheduler policy module. Add scheduler
event/snapshot/decision unions and deterministic selection tests covering:

- one slot per Conversation;
- two Conversations selected in one round;
- same Conversation's second Task queued;
- global attempt cap;
- per-Task attempt cap;
- priority and aging;
- fair tie-breaking and restart-stable ordering;
- resource-conflicted candidates skipped without affecting unrelated Tasks;
- no preemption.

Modify `ControlKernel` to consume this snapshot and emit the new decision.
Keep all selection logic out of Runtime and UI.

### Phase 3: Account coordinator and immutable Runtime routing

Remove mutable snapshot/runtime references from
`AccountKernelCoordinator`. Introduce an Account-owned snapshot builder and
Task/Conversation keyed Runtime application router. Replace background
`AsyncLocalStorage` identity lookup with explicit immutable bindings for
dispatch, attempt, recovery and publication callbacks.

Add concurrency tests that submit A and B events with deliberate async delays
and prove each decision is applied to its own Task/Conversation.

### Phase 4: Cross-Task AttemptSupervisor and resource scheduling

Make supervisor contexts attempt-scoped, implement account-wide kick/drain,
add per-Task limits, and integrate durable scheduler reservations. Extend
resource conflict facts across Tasks and make lease ownership diagnostics
explicit. Add delayed fake Executor tests that prove A and B overlap while two
Tasks from one Conversation never overlap.

### Phase 5: Worktree publication, cancellation and recovery

Update publication coordination for multiple Tasks sharing one source
Workspace, preserving deterministic integration and conflict repair. Change
cancellation/recovery to operate on Task sets instead of a singleton cleanup
Task. Add crash/restart, cancellation, late-result and slot-release tests.

### Phase 6: Planner context and Gateway/UI projections

Make Planner MCP readers Conversation/Task scoped. Update context-ref
eligibility and execution evidence authorization to reject cross-Conversation
references. Split Conversation-local runtime projection from workspace/account
summary projection. Update Web/TUI/Feishu event routing and user-facing queue
messages without exposing detailed cross-Conversation context.

### Phase 7: Native and Docker acceptance

Add an end-to-end scenario with two Conversations, two delayed Tasks and a
shared AccountRuntime. Assert:

1. Task A starts;
2. Task B from another Conversation starts before A completes;
3. Task B receives no A transcript, evidence, permission request or worktree;
4. a second Task submitted to A remains queued;
5. A and B have independent trace/replay streams;
6. cancellation of A does not cancel B;
7. restart recovers both ownership slots and dispatch identities;
8. shared Workspace file conflicts go through publication conflict handling,
   not last-writer-wins overwrite.

Run the existing native Planner-session smoke and the Docker/Linux regression
suite. The new two-Conversation smoke must use the checked-in Planner fork and
the same process boundaries as production.

## Test Matrix

### Unit and pure policy

- `tests/kernel/control-kernel.test.ts`: scheduler snapshot/decision,
  Conversation slot, fairness, aging, no-preemption.
- `tests/work-graph/` or a new scheduler-owned test: candidate derivation and
  stable ordering.
- `tests/resource/partition.test.ts`: cross-Task claim overlap and unrelated
  claim independence.

### Storage and migration

- `tests/storage/task-repo.test.ts`: owner-scoped queries and queue entries.
- `tests/storage/kernel-workflow-repo.test.ts`: account scheduling event and
  decision identity.
- new migration tests: schema upgrade, slot uniqueness and rollback.

### Execution and recovery

- `tests/execution/attempt-supervisor.test.ts`: A/B overlap, per-Task cap,
  attempt-scoped context and account drain.
- `tests/execution/task-cancellation-coordinator.test.ts`: A-only cancellation
  and independent B cleanup.
- `tests/execution/workspace-publication-cancellation.test.ts`: shared source
  Workspace conflict and publication isolation.
- `tests/account/account-startup-recovery-service.test.ts`: all active Tasks,
  independent Task recovery block and slot retention.

### Context security

- `tests/planning/planner-mcp-server.test.ts`: Conversation-filtered session
  context and bounded cross-Conversation summaries.
- `tests/work-graph/context-ref-eligibility.test.ts`: interaction/evidence
  cross-Conversation rejection.
- `tests/execution/subtask-attempt-runner.test.ts`: no foreign worktree,
  handoff, resource or evidence access.

### Gateway and surfaces

- `tests/gateway/`: detailed event origin routing for A/B and replay after
  reconnect.
- `tests/session/`: one local active Task, queued same-Conversation Task,
  independent Conversation projections.
- `tests/integration/independent-client-lifecycle.integration.test.ts`: two
  Conversations under one Server/AccountRuntime.
- Web tests: directory summaries do not contain foreign detailed trace and
  Conversation switch preserves each Planner/session identity.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Mutable session callback routes A output to B | Persist Conversation ID and route by immutable owner; remove dynamic background binder identity |
| One Task consumes all four attempt slots | Per-Task attempt cap and fair account scheduling |
| Same source files are silently overwritten | Task worktrees plus serialized publication and existing conflict repair |
| Cross-Conversation evidence leaks through interaction IDs | Store/validate Task and Conversation ownership on every interaction reference |
| Restart releases a slot too early | Durable slot state and Phase 6 residue fence |
| A blocked Task freezes unrelated Conversations | Task-scoped recovery fences; account-wide block only for account ledger/schema corruption |
| Priority starves normal Tasks | Durable aging and fair-share tie-breaking |
| UI still assumes one running Task | Replace scalar runtime projections with Conversation-local and account-summary projections |
| Concurrent Planner turns corrupt Pi sessions | Retain per-session writer serialization; different sessions use different queues/files |
| Existing APIs accidentally reintroduce singleton behavior | Characterization tests and removal of `getSingleActiveTaskId` from Kernel inputs |

## Explicit Non-Goals

- forced preemption of a running Task;
- automatic cancellation of another Conversation's Task;
- sharing Planner transcripts between Conversations;
- merging Task-local evidence, memory or permissions;
- allowing an Executor to read another Task's worktree or sandbox;
- cross-Task semantic handoffs without an explicit Work Graph contract;
- multi-process AccountRuntime ownership or multi-account scheduling changes;
- changing the preserved standby Ink UI into a second Runtime;
- changing Provider/Model/AgentClass fallback or configuration revision rules;
- introducing LangGraph, a queue broker or a second scheduler framework;
- claiming that two Tasks editing the same source files can both publish
  without conflict handling.

## ADR and Documentation Work After Approval

After review approval, create a new current ADR, tentatively ADR-0037, that
amends or supersedes the active single-Task rule in ADR-0011/ADR-0026 and
explicitly amends the relevant scheduler, account-runtime, resource,
publication and Gateway contracts. The ADR must state the exact supported
cardinality and whether the same-Conversation queued behavior is accepted.

Then update, in one documentation change set:

- `CONTEXT.md` with the new account/Conversation/Task invariants;
- `docs/current/technical-overview.md` and its Chinese counterpart;
- `docs/adr/README.md` authority matrix;
- `docs/plans/future-multi-task-scheduling-roadmap.md` to mark the old deferral
  superseded by the accepted parallel design;
- the implementation plan with phase status, validation evidence and closure
  commit.

## 2026-08-30 Delivery Closure

The accepted parallel design and the follow-up production repairs are now
implemented on the `parallel` branch. The implementation closed in commit
`6b1559d`.

Delivered follow-up behavior:

- A failed Executor Attempt with safe partial text retains its original
  `KernelFailure`. In particular, `executor_timeout` remains a failed timeout
  observation, so existing Kernel policy emits `wait_for_retry` rather than
  routing the Attempt through uncertified-result correction and `block_work`.
- Pi JSONL processing uses one stream tracker per Attempt. An interrupted open
  assistant text stream is retained only as provisional output; thinking,
  tool-call deltas and tool results are excluded. An open stream can never be
  certified as a successful final response.
- Attempt diagnostics persist under `executor_attempt_runtime.progress_json`:
  process and pipe timestamps, stdout/stderr byte totals, termination source,
  sent termination signals, exit code, last safe Pi event kind, turn index,
  assistant-stream state, safe text byte count and public Provider/model
  identity. Prompts, credentials, hidden reasoning and raw tool payloads are
  not recorded in this projection.
- Selecting a Conversation immediately attaches and replays it. The separate
  `继续此会话` control and intermediate read-only prompt were removed.
- Switching back to a Conversation now preserves its replayed in-flight Turn,
  execution steps and details. The confirmed failure was a Web attach race:
  the Server replayed the running Turn before announcing the active
  Conversation, and the Client then cleared that replay again after the attach
  HTTP request completed. The Server now announces the target Conversation
  before replaying its in-flight Turn; the Client clears stale prior-
  Conversation state when selection starts and retains target-owned replay
  state when activation notifications and HTTP completion arrive.
- Settings exposes only `同时运行任务数`, backed by
  `runtimePolicy.maxConcurrentTasks`. Internal attempt, queue and aging policy
  remains configured and validated but is not user-editable in the ordinary
  UI.
- Provider completion now queries the configured OpenAI-compatible `/models`
  endpoint after credentials are available, merges discovered and configured
  model IDs, and refreshes the Settings catalog after successful activation.
  Discovery is bounded and failure-safe, and never returns the credential.
- The historical blocked incident Task was cleared through the supported
  Conversation-scoped `/task clear blocked` command. It was cancelled rather
  than recovered; immutable receipts and Kernel ledger history were not
  rewritten.
- A later confirmed Provider failure with safe summary `Connection error.` was
  incorrectly normalized as `unknown`, so explicit `/task resume` remained
  blocked. Generic connection failures now normalize to retryable network
  failures. Explicit Resume also performs a bounded compatibility check of the
  latest immutable receipt: only a legacy `unknown` summary that now clearly
  normalizes to `network` is submitted as `retry`. Generic unknown, permission,
  material, contract and external-effect failures remain fail-closed;
  historical receipts and Kernel Decisions are never rewritten.
- Settled Attempt duration now freezes at the receipt completion timestamp;
  only active Attempts continue advancing in the Web execution narrative.
- Startup recovery no longer attempts to apply a second `RUNNING -> BLOCKED`
  transition when an already blocked Task is rediscovered through its occupied
  Conversation slot. The existing blocker remains unchanged and normal durable
  recovery continues, making repeated Server startup idempotent for this state.
- The Conversation Sidebar now treats the selected Conversation's live running
  Turn as newer evidence than a stale directory activity summary. A resumed
  Task therefore displays `执行中` while its live Turn is running even if the
  last directory snapshot still says `blocked`; after the Turn settles, the
  durable directory state becomes authoritative again.
- A Kernel `block_work` decision now publishes a terminal
  `execution_blocked` interaction-trace event only after the Task/Subtask
  blocking mutation succeeds. The event carries the bounded Kernel reason and
  `traceStatus: blocked`, so Web no longer leaves a failed verification Turn
  indefinitely at “Runtime is certifying for delivery”; it renders `阻塞`,
  shows the reason, sets the completion time and persists the blocked Turn.
- `resume` now recognizes the historical `completion_malformed(report)` blocker
  and authorizes a single response-only metadata correction without rerunning
  the expensive research attempt. A successful correction preserves the
  original safe business result, certifies its completion metadata, marks the
  Subtask done and lets the existing Kernel completion path finish the Task.
- Metadata correction no longer creates a second Git publication candidate or
  leaves the Subtask in `awaiting_integration`. Startup recovery also accepts
  the legacy publication shape produced before this fix, but only when the
  correction receipt explicitly points to its original source attempt; normal
  publication attempt identity checks remain strict.

Validation completed on 2026-08-30:

- `npm run lint`
- `npm run build`
- focused Executor, Attempt, Runtime, Kernel, configuration and Web suites
- focused recovery and Web-duration regression run: 20 files and 134 tests
  passed
- account startup recovery composition: 10 tests passed, including an occupied
  Conversation slot whose active Task was already blocked
- focused network Resume and fail-closed safety regression: 6 files and 75
  tests passed
- Sidebar live-activity reconciliation: 5 files and 18 tests passed
- blocked-terminal trace propagation: 2 files and 29 tests passed, covering
  post-persistence Runtime emission and Web blocked-Turn persistence
- related InteractionTrace, Conversation session and Web presentation
  regression: 5 files and 29 tests passed
- Web Conversation-switch regression coverage, including a headless Chrome
  B-to-A switch where A's running Turn is replayed before the attach HTTP
  response completes and remains visible after historical record refresh
- `npm test`: 368 test files and 1,794 tests passed; 8 browser/Docker-gated
  files and 20 tests remained skipped under their existing environment
  contracts.
- Real recovery validation: Task
  `task_plan_event_proposal_267f5d032703e723c83bb55a1b89d4fef82e87bbfd897799d5fc5016144faf10`
  resumed from `blocked`, completed one `contract_correction` attempt, did not
  create a new `primary` attempt, and reached `Task=done` /
  `Subtask=done` after restart recovery. The legacy correction publication was
  integrated successfully without changing immutable receipts or Kernel
  ledger history.

The exact root cause of the original five-minute Pi stream silence remains
unconfirmed. The confirmed timeout-classification bug is closed; the new
bounded diagnostics are the evidence gate for distinguishing future Provider
silence, Pi event parsing/forwarding failure and process-level pipe silence.
