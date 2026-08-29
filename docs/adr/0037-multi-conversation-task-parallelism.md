# ADR-0037: Multi-Conversation Top-Level Task Parallelism

- **Status**: Accepted
- **Date**: 2026-08-29
- **Scope**: Top-level Task admission, Conversation-scoped serialization, AccountRuntime scheduling, context isolation, recovery and cross-Conversation projections
- **Amends**: ADR-0011, ADR-0025, ADR-0026, ADR-0031, ADR-0035, ADR-0036
- **Preserves**: ADR-0020, ADR-0021, ADR-0022, ADR-0023, ADR-0024, ADR-0028, ADR-0032, ADR-0033, ADR-0034
- **Related design**: `docs/plans/2026-08-29-multi-conversation-parallel-task-design.md`
- **Governed by**: ADR-0020

## Context

The Phase 6 single-Task boundary correctly established durable dispatch,
attempt-scoped execution, resource leases, Git publication and recovery. It
also retained an account-wide admission restriction that permits only one
active top-level Task. The product now requires independent Conversations in
one AccountRuntime to run concurrently while preserving strict Conversation
context isolation.

The restriction is therefore relaxed only at the AccountRuntime boundary. It
is not replaced by a second scheduler, a Runtime per Task, dynamic session
binding, implicit preemption or last-writer-wins Workspace publication.

## Decision

### Cardinality and queueing

Each top-level Task has an immutable owner tuple:
`accountId`, `conversationId`, `workspaceId`, `plannerSessionId` and
`generationId`. A Conversation owns one durable execution slot. At most one
top-level Task owned by that Conversation may be executing or cleaning up at
any time. A later Task is durably queued and is not dispatched until the slot
is released. Tasks owned by different Conversations may execute concurrently,
subject to AccountRuntime capacity and resource leases.

The slot remains occupied while execution, attempt, publication, WorkUnit,
lease, cancellation or recovery residue is active or uncertain. A blocked or
parked Task with no residue releases its slot; resuming it must reacquire the
same slot and therefore may queue behind another Task in that Conversation.
Queue admission is bounded by `sameConversationQueueLimit`; a rejected request
does not create a partial Task.

### Account scheduling

One AccountRuntime continues to own one Kernel coordinator, durable
KernelWorkflow, ControlKernel, AttemptSupervisor, resource/recovery services
and publication gate. An account-scoped scheduling event causes ControlKernel
to select candidates from a deterministic all-Conversation snapshot. Runtime
applies the resulting durable reservations and dispatch items atomically.

Scheduling is cooperative and non-preemptive. Selection uses validated
priority, aging, durable fair-share ordering, `maxConcurrentTasks`, global
`maxConcurrentAttempts` and `maxConcurrentAttemptsPerTask`. A higher-priority
arrival never revokes an active attempt. A Conversation slot race is resolved
by a durable conditional claim; the losing decision is re-evaluated and cannot
launch work.

The initial runtime policy is:

| Field | Default | Range |
| --- | ---: | ---: |
| `maxConcurrentTasks` | `2` | `1..8` |
| `maxConcurrentAttempts` | `4` | `1..32` |
| `maxConcurrentAttemptsPerTask` | `2` | `1..32`, no greater than global cap |
| `schedulingAgingMs` | `300000` | `0..86400000` |
| `sameConversationQueueLimit` | `8` | `0..32` |

These are revisioned system configuration fields exposed through the existing
Configuration Control Plane and Settings UI/API. Existing configurations use
defaults when fields are omitted. Lowering a limit affects later scheduling
rounds and never cancels running work.

### Context and publication isolation

Planner transcript, user input, Task evidence/resources, task-local memory,
permissions, dependency handoffs, worktrees, private runtime homes and
detailed live events are Conversation/Task scoped. Shared Account or Workspace
identity does not authorize context sharing. Any cross-Conversation handoff
requires a future typed Work Graph contract.

Tasks sharing a Workspace use distinct managed worktrees. Publication remains
serialized and overlapping changes enter the existing conflict-repair chain;
Runtime never silently overwrites a result.

Workspace directories may expose only bounded summaries: title, status,
Conversation display label, timestamps and bounded activity state. Detailed
transcript, evidence, resources, permissions, raw output and trace require an
authorized attach to the owning Conversation.

### Recovery and routing

Every background event, decision, dispatch item, attempt, lease, publication
and Gateway projection carries or resolves immutable Task/Conversation
identity. Background execution, recovery and publication may not identify a
Task through mutable `currentSessionId()` or a last-bound callback. The
Conversation binder remains only as a compatibility adapter for synchronous
Conversation-facing entrypoints.

Recovery fences are Task-scoped where possible. A Task-specific recovery block
does not freeze unrelated Conversations; account-wide ledger, schema or
identity corruption still blocks the AccountRuntime.

## Consequences

ADR-0011's account-wide single-active-Task rule is superseded by the durable
Conversation slot and queue rule above. ADR-0025/0026's attempt, publication,
cancellation and completion fences remain authoritative and are extended to
operate over multiple top-level Tasks. ADR-0031/0035/0036 retain their Account,
Workspace, Conversation and origin-scoped delivery boundaries.

The implementation is a hard schema/protocol migration. It must remove scalar
single-Task assumptions from Kernel policy and Runtime projections, add focused
tests for A/B overlap and same-Conversation serialization, and pass native and
Docker acceptance scenarios before this ADR is considered operationally
closed.
