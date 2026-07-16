# ADR-0017: Kernel Executor Status Projection

- Status: Accepted
- Date: 2026-07-16
- Scope: static Planner executor catalog and Kernel-owned dynamic executor-status projection

## Context

Executor facts currently reach the Planner through `list_executor_classes`. That MCP query combines stable AgentClass metadata with WorkUnit-state counts and implementation details. It makes the Planner fetch static routing facts at runtime and gives it a view of capacity that does not match the intended executor model: selecting an AgentClass starts an independent instance, so an already-running WorkUnit does not make the class busy or unavailable.

The Planner needs two different inputs:

1. a stable description of the configured executor classes and their routing differences; and
2. a current, bounded indication of each class's health and recent outcomes.

The second input is also a control-plane concern. The future Kernel expansion recorded in `kernel-decision-authority-scattered-in-runtime-debt.md` will own scheduling and recovery decisions, but that work is not part of this ADR. This decision establishes the durable status vocabulary and projection boundary it can later consume.

## Decision

### Inject the static executor catalog into Planner context

The Planner receives a stable, Planner-safe static executor catalog when each planning run starts. It contains routing differences and key affordances only; it does not contain live health, WorkUnit state, capacity, runtime commands, credentials, raw logs, or tool transcripts.

The Planner does not query MCP for this static catalog. This retains ADR-0016's startup-injection rule.

### Persist a Kernel Executor Status Projection

The system keeps one persisted `Kernel Executor Status Projection` row per AgentClass. It is a current control-plane projection derived synchronously from confirmed Runtime work-unit facts and execution outcomes. It is not an execution log, a WorkUnit, or a capacity pool.

Each row exposes the following Planner-safe data:

- `agentClassName`;
- `classHealth`: `unverified`, `healthy`, `error`, or `disabled`;
- up to the three most recent execution attempts, each with completion time, success/failure outcome, classified failure kind, and safe reason text.

No prompt, model output, tool trace, raw process output, credential, or runtime command is exposed through this projection.

`classHealth` means:

| State | Meaning | Planner candidate behavior |
| --- | --- | --- |
| `unverified` | The class is registered but has no health-confirming runtime fact. | May be selected. |
| `healthy` | No confirmed AgentClass-level fault currently prevents a new instance from starting. | May be selected. |
| `error` | A confirmed AgentClass-level fault prevents normal use, such as invalid adapter binding, missing required command, or incompatible class configuration. | Excluded by default. |
| `disabled` | The class was explicitly disabled by administration or policy, not by a runtime incident. | Must not be selected. |

A busy, running, waiting, or failed WorkUnit is an instance fact and never becomes an AgentClass health state. A single network or timeout failure is recorded in recent attempts but does not make the AgentClass unhealthy. The later Kernel control-plane work owns transition rules for systemic failure, recovery, retry caps, circuits, and re-enable behavior.

### Put projection ownership in the Kernel subsystem without making PolicyKernel impure

`PolicyKernel` remains a pure decision component. A new `KernelExecutorStatusProjector` belongs to the Kernel subsystem and owns projection semantics. Runtime records confirmed execution facts; the projector synchronously updates the persisted projection in the same handling chain. The Planner and `PolicyKernel` read the resulting projection.

This establishes Kernel ownership of the control-plane state model while preserving the rule that Runtime performs process execution, WorkUnit lifecycle effects, and storage application.

### Expose only dynamic status through Planner MCP

Planner MCP replaces the mixed `list_executor_classes` capability query with a dynamic status query. It returns the bounded projection rows above. Static catalog facts remain startup context, while the dynamic query helps Planner order its single `executorCandidates` list.

The Planner emits one ordered `executorCandidates` list per Subtask. Its first item is the preferred class and remaining items are approved fallback order. The Kernel validates registered AgentClass membership and current health constraints; the static catalog remains the Planner's built-in routing input and does not invalidate pre-existing registered custom classes. Runtime still starts/claims the concrete instance and tries the approved list in order. A Runtime failure immediately updates the projection for subsequent planning, but does not retroactively change an already-approved plan.

## Consequences

- Planner has a small stable capability context and a separate, current health query.
- `busy` and raw capacity are not routing signals for AgentClasses that start independent instances.
- A transient instance failure remains visible to Planner without falsely declaring its AgentClass unusable.
- The Kernel gains a durable control-plane state boundary that future scheduling/recovery work can extend without redefining Planner-facing vocabulary.
- This ADR supersedes the portion of ADR-0016 that treats all live executor facts as excluded from Planner access: live facts remain excluded from startup catalog injection, but the bounded status projection is available through a dedicated read-only Planner MCP query.

## Deferred

- Automatic health transitions, recovery, circuit breaking, retry limits, and periodic rechecks;
- execution-failure fallback policy beyond Runtime's existing ordered attempt behavior;
- capacity limits, shared worker pools, and parallel scheduling;
- additional Executor classes and custom-Executor certification.
