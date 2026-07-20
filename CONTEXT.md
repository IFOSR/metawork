# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

The active control path is `event -> snapshot -> ControlKernel.decide -> kernel_decisions -> Runtime apply -> normalized event`. The isolated Codex `PlanningAgent` owns natural-language semantics and proposes a strict v4 plan, but Planning and Runtime facts enter the same versioned Kernel event seam. The synchronous `KernelControlLoop` persists every Decision before applying its single high-level action.

`src/planning/` owns the PlanningAgent interface (`CodexPlanningAgent`), dedicated Codex runner, Planner MCP, minimal planning context, strict v4 structured output, and catalog-aware validation. `src/work-graph/` owns the shared v4 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Planner timeout, MCP failure, or invalid output after one repair fails closed to clarification; there is no v3 parser, legacy intent route, semantic default, or keyword fallback.

`src/kernel/` owns the pure `ControlKernel` and the deep control-loop interface. `ControlKernel` reads no time, IDs, repositories, adapters or raw logs. Storage and Runtime implement the ledger and apply seams from outside the Kernel module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. Success atomically commits receipt, handoff, result and `done`; every non-success atomically commits a terminal receipt and `awaiting_decision`. It releases the WorkUnit before returning a normalized Kernel event. A first completion-contract failure may receive one response-only correction on the same AgentClass; the isolated correction has no normal Subtask context, evidence tools or writable workspace.

Migration v23 renamed `planning_decisions` to immutable `planning_decisions_legacy_audit` and introduced the unified `kernel_decisions` ledger with a unique event ID. `awaiting_decision` is a Subtask-only state. `/task resume` and `/task unblock` submit `dispatch_requested` before changing execution state; startup blocks orphaned work through a persisted Kernel decision; timers reconsider only ledger-authorized capacity blocks.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The active path is `PlanningAgent → ControlKernel → KernelControlLoop → Runtime handlers → SubtaskAttemptRunner`; do not reintroduce a parallel strategic interpreter.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions. A missing non-canonical configured default is materialized as an unclassified AgentClass with no routing capabilities, while an existing non-canonical class is not rewritten. On the first startup after this convergence change, legacy fine-grained Codex/Pi capability metadata is irreversibly replaced by the controlled Routing Capability IDs. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. The retired `executor_profiles` table is removed by migration v20.

When touching dispatch, update focused behavior tests around `ControlKernel`, `KernelControlLoop`, the decision ledger, work-graph runtime, work-unit claims and attempt landing. Attempt terminal regressions remain anchored in `tests/execution/subtask-attempt-runner.test.ts` and `tests/session/planning-agent-session-routing.test.ts`.

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
A strict v4 proposal from the PlanningAgent describing intent, target, task control, risk, confidence, clarification needs, and either one non-empty work graph for `plan_work_graph` or `null` for every other action. Work-graph nodes use structured dependencies, typed context references, keyed acceptance criteria, controlled capabilities, and ordered AgentClass preferences. A plan is not executable until a `plan_proposed` event is authorized or rewritten by `ControlKernel` and recorded in the decision ledger.
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
The sole execution-structure fact for one task: a v4 DAG of capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every edge has one to twelve keyed `text` or `artifact` items; only completed direct-edge handoffs enter downstream context. Runtime consumes one ready node at a time. Concurrency, retry, fallback, and workspace-state handoff are later phases.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing keyed requirements, Planner-selected evidence, sibling identities marked out of scope, workspace/attempt identity, completion contract, and evidence-tool availability.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Completion Protocol**:
The required final Executor response contract: non-empty clean Markdown followed by exactly one `metaclaw:completion:v1` strict JSON envelope. Runtime validates acceptance evidence, exact handoffs, budgets, and artifact containment, then strips the envelope from every user-facing and memory-facing result.
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

**Worktree Isolation**:
The mechanism for running parallel executor work units without mutual file interference. Each parallel or isolated execution receives a dedicated git worktree. The service boundary exists, but true parallel worktree execution is not the first-version active path.
_Avoid_: workspace lock, file locking, sandbox

**Worktree Lease**:
The runtime claim that one work unit currently owns a specific worktree for one subtask. A lease has an owner, heartbeat, expiry, and release path so crashed executions can be detected and the worktree can be made available again.
_Avoid_: permanent workspace ownership, executor identity, static work directory assignment
