# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

Phase 5 completed the serial control and resource-safety baseline. The active path is `event -> durable inbox -> KernelWorkflow -> snapshot -> ControlKernel.decide -> immutable decision ledger + application -> idempotent Runtime apply -> normalized observation inbox`. Every Executor attempt runs in a fresh Docker sandbox while its Task-generation/Subtask workspace persists across attempts. The isolated Codex `PlanningAgent` still owns natural-language semantics; Planning and Runtime facts enter the same versioned Kernel event seam. `ControlKernel` remains the only strategic authority for retry, fallback, replan, partition waiting, permission grant/deny/escalation and sandbox recovery. Phase 6 may add concurrency without changing these identities or authority boundaries.

`src/planning/` owns the PlanningAgent interface (`CodexPlanningAgent`), dedicated Codex runner, Planner MCP, minimal planning context, strict v6 structured output, and catalog-aware validation. v6 adds only exact pending-request `authorization_resolution`; Work Graph remains v5 and Planner does not enumerate resource claims. `src/work-graph/` owns the shared v5 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Planner timeout, MCP failure, or invalid output after one repair fails closed to clarification; there is no earlier-schema production parser, legacy intent route, semantic default, or keyword fallback.

`src/kernel/` owns the pure `ControlKernel` and the deep control-loop interface. `ControlKernel` reads no time, IDs, repositories, adapters or raw logs. Storage and Runtime implement the ledger and apply seams from outside the Kernel module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. Success atomically commits receipt, handoff, result and `done`; every non-success atomically commits a terminal receipt and `awaiting_decision`. It releases the WorkUnit before returning a normalized Kernel event. A first completion-contract failure may receive one response-only correction on the same AgentClass; the isolated correction has no normal Subtask context, evidence tools or writable workspace.

Migration v23 renamed `planning_decisions` to immutable `planning_decisions_legacy_audit` and introduced the unified `kernel_decisions` ledger with a unique event ID. Phase 4's v24 persistence separates durable events, Decision applications, external effects, attempt continuation metadata and work-graph revisions from that immutable authorization ledger. Phase 5's v25 persistence archives the unused worktree-lease shape and adds resource leases/waits, workspace/checkpoint/CAS metadata, permission requests/grants/user authorizations, attempt sandboxes and AgentClass image/profile bindings. `awaiting_decision` remains a Subtask-only state; startup recovery must reach a safe quiescent point before Session or Gateway accepts input.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The target active path is `PlanningAgent/Application Shell → KernelWorkflow → ControlKernel → idempotent Runtime handlers → SubtaskAttemptRunner`; do not reintroduce a parallel strategic interpreter or allow a workflow framework to own domain retry policy.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions, including immutable execution image and permission profile bindings. A missing non-canonical configured default is materialized as an unclassified, non-executable AgentClass, while an existing non-canonical class is not rewritten. Custom classes without a valid image ID and permission profile remain audit-visible but fail closed. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. There is no production host-process Executor fallback.

When touching dispatch, update focused behavior tests around `ControlKernel`, `DurableKernelWorkflow`, the decision/application ledger, work-graph runtime, work-unit claims and attempt landing. Attempt terminal regressions remain anchored in `tests/execution/subtask-attempt-runner.test.ts` and `tests/session/planning-agent-session-routing.test.ts`.

## Routing Language

**Task**:
A durable top-level unit of user work. Phase 3 admits at most one active top-level Task while a Task may contain multiple Subtasks.
_Avoid_: request, prompt, executor run, browser tab

**Subtask**:
A decomposed piece of work inside a Task, planned so it can be claimed and executed by one WorkUnit at a time. Its lifecycle is `ready | running | awaiting_decision | blocked | done | cancelled`.
_Avoid_: work unit, executor instance, raw prompt

**Task State**:
The top-level Task lifecycle: created, ready, running, parked, blocked, done, archived, and cancelled. It never contains `awaiting_decision`.
_Avoid_: executor state, work unit state

**Agent Class**:
A fixed configuration template for a type of agent, including its harness, model, skills, MCP servers, plugins, runtime command, affinity metadata, and runtime settings. MetaClaw starts with canonical planner and executor classes.
_Avoid_: executor profile, capability class, instance, worker

**Routing Capability**:
A controlled, supported delivery contract that helps Planner prefer an Executor AgentClass. It is not an exhaustive inventory of that Executor's native tools, permissions, or theoretical abilities.
_Avoid_: tool list, hard permission, free-form capability tag

**Executor Catalog**:
The canonical static definitions of built-in Executor AgentClasses and the Planner-safe projection derived from them. Dynamic class health and recent execution outcomes are not part of this catalog.
_Avoid_: executor status, Work Unit capacity, runtime inventory

**Planner**:
The agent class responsible for understanding user intent and proposing structured plans. A concrete planner work unit implements the PlanningAgent interface; it proposes but does not authorize or apply runtime state changes.
_Avoid_: leader, router agent, implementation agent, executor

**PlanningAgent**:
The small interface exposed by a planner work unit: given a planning context, return a structured PlanningAgentPlan. It is the semantic understanding seam, not a storage or runtime authority.
_Avoid_: policy kernel, session intent service, executor

**PlanningAgentPlan**:
A strict v6 proposal from the PlanningAgent describing intent, target, task control, risk, confidence and clarification needs. It contains one non-empty v5 work graph only for `plan_work_graph`, or an exact approve/deny resolution only for a pending `authorization_resolution`; all other action-specific fields are null. Work-graph nodes use structured dependencies, typed context references, keyed acceptance criteria, controlled delivery capabilities and ordered AgentClass preferences. A plan is not executable until its durable event is authorized or rewritten by `ControlKernel` and recorded in the decision ledger.
_Avoid_: runtime command, task event, execution policy

**ControlKernel**:
The pure deterministic decision module for Planning, dispatch, capacity, execution outcome, contract failure and timer events. Its only public Interface is `decide(event, snapshot)`.
_Avoid_: planning agent, runtime applier, executor router

**KernelDecision**:
The one high-level authorization that Runtime may apply. Its identity is deterministically derived from the triggering event ID.
_Avoid_: raw plan, route decision, executor output

**KernelSnapshot**:
The minimal, complete and bounded immutable facts required for one Kernel event.
_Avoid_: live repository handle, mutable runtime state, session transcript

**Executor**:
The agent class responsible for carrying out claimed subtasks and reporting results back to the planner/task context. Executors do not own task planning.
_Avoid_: planner, leader, router

**Work Unit**:
A concrete runtime agent instance that belongs to an agent class and can be either a planner or an executor. A work unit is the runtime slot that starts, idles, claims work, runs, waits, heartbeats, drains, fails, or stops.
_Avoid_: subtask, task, agent class, capability class

**Work Unit State**:
The runtime lifecycle vocabulary for work units: starting, idle, claimed, running, waiting, heartbeat_lost, failed, draining, and stopped.
_Avoid_: task state, subtask state

**Work Graph**:
The sole execution-structure fact for one task generation: a v5 revisioned DAG of capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every edge has one to twelve keyed `text` or `artifact` items; only completed direct-edge handoffs and controlled task evidence enter downstream context. Runtime consumes one ready node at a time. Retry, fallback, continuation and one bounded replan are Kernel policy; concurrency remains a later phase.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing keyed requirements, Planner-selected evidence, sibling identities marked out of scope, workspace/attempt identity, completion contract, and evidence-tool availability.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Completion Protocol**:
The required final Executor response contract: non-empty clean Markdown followed by exactly one `metaclaw:completion:v2` strict JSON envelope. Runtime validates acceptance evidence, exact handoffs, budgets, and artifact containment, then strips the envelope from every user-facing and memory-facing result.
_Avoid_: best-effort trailer, inferred handoff, visible machine block

**Execution Evidence**:
The attempt-bound, Task-scoped read-only port for eligible user input, user materials, and confirmed preferences. Ordinary assistant/Executor output and dependency results are not generally searchable; an explicitly authorized assistant interaction is exact-get only.
_Avoid_: conversation transcript, cross-task search, dependency output channel

**Attempt Receipt**:
The immutable terminal audit for one Task/Subtask/attempt/WorkUnit/AgentClass invocation, including raw response and parsing/verification facts. Phase 2 receipts do not contain retry, fallback, backoff, or workspace-state policy.
_Avoid_: retry state machine, user-visible result, mutable handoff

**Work Unit Event**:
A durable runtime event about a work unit, such as state changes, claims, heartbeats, failures, draining, or stop events.
_Avoid_: TUI output line, transient progress text, task message

**Kernel Executor Status Projection**:
The Kernel-owned, persisted, one-row-per-AgentClass current control-plane view of class health and recent execution outcomes, synchronously derived from Runtime work-unit facts and execution outcomes. AgentClass instances are independently started, so a busy Work Unit does not change this projection; it is not a Work Unit or an execution log.
_Avoid_: AgentClass availability, Work Unit state, executor call log

**AgentClass Health**:
The Kernel's classification of whether an AgentClass itself is usable: unverified, healthy, error, or disabled. A failed executor instance does not change class health unless its cause proves a class-level fault or meets the configured systemic-failure rule.
_Avoid_: Work Unit status, last execution result, capacity

**Recent Execution Outcome**:
The latest recorded result and classified reason for an AgentClass execution attempt. It informs Planner choice without by itself making the AgentClass unhealthy.
_Avoid_: AgentClass Health, executor availability

**Recent Execution Attempts**:
The bounded, Planner-safe history of the three latest execution outcomes for one AgentClass. It contains outcome time and classified reason, not prompts, raw logs, tool traces, or credentials.
_Avoid_: execution transcript, executor call log

**Task Event**:
A durable event about a task or subtask, such as planned, recovered, dispatched, blocked, succeeded, failed, cancelled, or resumed. Task events are the replayable source of truth for planner recovery; session output is only a UI projection.
_Avoid_: executor-only log, route event, progress line

**Task Runtime View**:
The runtime picture MetaClaw maintains for a task: the task conversation, subtasks, current work graph, claimed work units, progress, and reports.
_Avoid_: executor-only status, route event, transcript

**No Action**:
A valid planner outcome meaning no subtask should be dispatched. The runtime must preserve it as an intentional decision rather than forcing an executor run or marking the task done.
_Avoid_: failure, clarification, unknown route

**Selection Signal**:
A controlled fact used by Planner to order AgentClasses for a Subtask, such as a static Routing Capability or current AgentClass Health and Recent Execution Outcome. Natural-language keyword weights, legacy AgentClass availability, and WorkUnit busy state are not selection signals.
_Avoid_: static historical success as truth, user preference

**Preferred AgentClass List**:
The ordered AgentClasses proposed for one Subtask. The first item is preferred and the remaining items form its fallback chain; the list is still subject to Kernel validation before execution.
_Avoid_: unordered candidates, Work Unit pool, capability registry

**Fallback Chain**:
The ordered tail of a Preferred AgentClass List after its first item. Runtime may try these already-approved alternatives in order when the preferred class cannot be used; new cross-class retry and recovery policy remains a separate Kernel concern.
_Avoid_: preferred AgentClass, race, parallel candidates, unplanned platform reroute

**Verification Level**:
The strength of post-execution validation: none, compile, test, or review.
_Avoid_: quality gate, acceptance check, validator

**Persistent Workspace**:
The private Task-generation/Subtask working state that survives disposable attempt containers. Git work uses MetaClaw-managed worktrees and branches; non-Git work uses a managed directory, immutable checkpoint manifests and content-addressed objects. Downstream nodes consume only versioned direct-dependency `workspace_state`.
_Avoid_: attempt container, user repository, unversioned sibling directory

**Resource Lease**:
The attempt-bound claim over one normalized repository, worktree, mount-relative path, logical resource or external object. It records read/write access, owner, heartbeat, expiry, release and wait relationships; overlapping claims conflict whenever either side writes.
_Avoid_: permanent workspace ownership, WorkUnit identity, host absolute path

**Capability Request**:
An Executor's structured request for one concrete operation outside its default AgentClass permission profile. Runtime canonicalizes it; Kernel v3 alone grants a bounded capability, denies with an Executor-visible reason, or denies and escalates the exact request to Planner/user authorization. A granted request returns an opaque grant ID but does not itself widen sandbox authority. Runtime supplies versioned explicit rules: exact Task-registered read partitions, plus normalized public HTTP(S) targets only for the public-web-research profile; secrets and mutations are never profile-allowed.
_Avoid_: Planner resource claim, stderr parsing, broad permission prompt

**Capability Use**:
One attempt-bound, broker-mediated consumption of a previously granted capability. The Executor supplies the exact operation payload; trusted Runtime measures its UTF-8 size and atomically enforces attempt identity, expiry, call and byte budgets before a controlled adapter may act.
_Avoid_: direct external access, caller-declared byte count, reusable host credential
