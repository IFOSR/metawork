# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

The active natural-language path is `PlanningAgent -> PolicyKernel -> Runtime`. A planner work unit implements the `PlanningAgent` interface, which understands the user input and proposes a structured `PlanningAgentPlan`. The deterministic `PolicyKernel` validates or rewrites that plan against the current runtime snapshot and returns a `KernelDecision`. Runtime services then apply that decision by answering directly, applying task control, creating or binding a task, persisting approved subtasks, claiming an idle executor `WorkUnit`, or calling `ExecutionRuntime` with a `SubtaskExecutionSpec`.

`src/planning/` owns the PlanningAgent interface (`CodexPlanningAgent`), planning context construction, plan types/vocabulary, and plan validation. The old `IntentOrchestrator`/`IntentDecisionV2`/`ExecutorProfile` routing layer has been removed; there is no legacy intent-orchestrator fallback.

`src/kernel/` owns deterministic policy authorization. It may accept, rewrite, reject, or clarify a plan, but it must not write storage, claim work units, call executors, or send delivery messages.

`src/execution/work-unit-claim-service.ts` is the runtime resource arbitration layer. It owns claim, running, waiting, failure, release, heartbeat, and heartbeat-lost transitions for concrete work units. `SessionExecutionCoordinator` calls its lightweight sweep before dispatch and claim attempts so expired executor leases can be observed and their subtasks can be made recoverable.

The legacy routing/intent subsystem (`src/core/executor-router.ts`, `src/core/intent-orchestrator.ts`, `src/core/semantic-intent-router.ts`, `src/core/execution-planning-service.ts`, `src/routing/execution-policy-planner.ts`, and the `src/planner/` skill subtree) has been fully removed. The active execution path is `PlanningAgent → PolicyKernel → SessionExecutionCoordinator → WorkGraphRuntimeService`; do not reintroduce a parallel routing layer.

Default agent classes and fixed first-pool work units are seeded in `src/executor/agent-class-seeder.ts`: `planner`/`planner-1` and the configured executor agent class/`executor-1`. Existing `executor_profiles` rows migrate into `agent_classes` as `kind=executor`.

When touching dispatch, update focused tests around the active path first: PlanningAgent/PolicyKernel, work-graph runtime service, work unit claim service, session execution coordinator, execution runtime, and storage migrations. The current regression anchor is `tests/session/planner-work-unit-bugfix.test.ts`.

## Routing Language

**Task**:
A user-opened conversation window with a unique id and its own durable context, including user messages, task state, execution results, and later re-entry. A task may contain multiple subtasks, and tasks and subtasks use the same task state vocabulary.
_Avoid_: request, prompt, executor run, browser tab

**Subtask**:
A decomposed piece of work inside a task, planned so it can be claimed and executed by one work unit at a time. Subtasks share the task state vocabulary rather than having a separate lifecycle language.
_Avoid_: work unit, executor instance, raw prompt

**Task State**:
The shared lifecycle vocabulary for tasks and subtasks, currently including states such as created, ready, running, parked, blocked, done, archived, and cancelled.
_Avoid_: executor state, work unit state

**Agent Class**:
A fixed configuration template for a type of agent, including its harness, model, skills, MCP servers, plugins, runtime command, affinity metadata, and runtime settings. MetaClaw starts with canonical planner and executor classes.
_Avoid_: executor profile, capability class, instance, worker

**Planner**:
The agent class responsible for understanding user intent and proposing structured plans. A concrete planner work unit implements the PlanningAgent interface; it proposes but does not authorize or apply runtime state changes.
_Avoid_: leader, router agent, implementation agent, executor

**PlanningAgent**:
The small interface exposed by a planner work unit: given a planning context, return a structured PlanningAgentPlan. It is the semantic understanding seam, not a storage or runtime authority.
_Avoid_: policy kernel, session intent service, executor

**PlanningAgentPlan**:
A structured proposal from the PlanningAgent describing intent, target, task control, executor candidates, optional work graph proposals, risk, confidence, and clarification needs. A plan is not executable until the PolicyKernel accepts or rewrites it.
_Avoid_: runtime command, task event, execution policy

**PolicyKernel**:
The deterministic authorization module that validates or rewrites a PlanningAgentPlan against the current RuntimeSnapshot. It is the only natural-language policy seam allowed to approve task creation, task control, work graph persistence, executor selection, or clarification.
_Avoid_: planning agent, runtime applier, executor router

**KernelDecision**:
The PolicyKernel output that the runtime may apply. It records whether the plan was accepted, rewritten, rejected, or converted into clarification, and contains the runtime action to perform.
_Avoid_: raw plan, route decision, executor output

**RuntimeSnapshot**:
The immutable view of current session, task, subtask, agent class, and work-unit state used by the PolicyKernel to decide whether a plan is allowed.
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
The dependency graph of subtasks under one task. It describes what must be done, which subtasks depend on which prior subtasks, and what agent class or execution capability each subtask requires.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**SubtaskExecutionSpec**:
The runtime input shape for executing a claimed subtask: subtask, executor work unit, agent class runtime configuration, task context, expected output, and acceptance requirements.
_Avoid_: ExecutionPolicy, primaryExecutor, candidateExecutors, fallbackChain

**Work Unit Event**:
A durable runtime event about a work unit, such as state changes, claims, heartbeats, failures, draining, or stop events.
_Avoid_: TUI output line, transient progress text, task message

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
A hard, quantifiable fact provided to the planner or routing skill package when multiple work units can satisfy a subtask, such as route-intent affinity, recent success rate, pending load, price, or current availability.
_Avoid_: static historical success as truth, user preference

**Fallback Chain**:
A future planner recovery pattern for trying another suitable executor after a failed or low-quality claim. It is not the active platform dispatch mechanism in the current implementation; first-version failures release the work unit, record events, and leave replanning to the planner/recovery path.
_Avoid_: race, racing, parallel candidates, automatic platform reroute

**Verification Level**:
The strength of post-execution validation: none, compile, test, or review.
_Avoid_: quality gate, acceptance check, validator

**Worktree Isolation**:
The mechanism for running parallel executor work units without mutual file interference. Each parallel or isolated execution receives a dedicated git worktree. The service boundary exists, but true parallel worktree execution is not the first-version active path.
_Avoid_: workspace lock, file locking, sandbox

**Worktree Lease**:
The runtime claim that one work unit currently owns a specific worktree for one subtask. A lease has an owner, heartbeat, expiry, and release path so crashed executions can be detected and the worktree can be made available again.
_Avoid_: permanent workspace ownership, executor identity, static work directory assignment
