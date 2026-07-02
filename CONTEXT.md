# MetaClaw Planner And Work Unit Context

The vocabulary for how MetaClaw turns a user task into planner-owned subtasks and runtime-owned work-unit claims. Exists because the old routing layer conflated several concepts (task, subtask, agent class, executor instance, policy, fallback) under one executor-routing path, which made long-thread recovery and lifecycle management hard to reason about.

## Current Implementation Notes

The active durable execution path is planner-first after session intake. Raw natural-language input still enters `IntentOrchestrator` and `SessionIntentApplicationService` first; that layer answers direct replies, applies task control, binds existing tasks, or creates durable tasks. Once a durable task is admitted and scheduled, session execution prepares durable task context, asks `src/planner/planner-runtime-service.ts` to recognize dispatch intent and produce or recover a work graph, persists `Subtask` nodes, claims an idle executor `WorkUnit`, and calls `ExecutionRuntime` with a `SubtaskExecutionSpec`.

`src/planner/intent-recognition-skill.ts` owns the reusable dispatch-intent normalization logic inside the durable execution path. It consumes the session-intake `IntentDecisionV2` when present, can guard against direct reply, task control, clarification, no action, and durable work outcomes, and must not output a selected executor or work unit.

`src/planner/planner-routing-skill.ts` owns reusable planning and routing heuristics. It may rank candidate `AgentClass` values and produce `SubtaskPlan` nodes, but it must not claim a `WorkUnit`, write route events, or produce an `ExecutionPolicy`.

`src/execution/work-unit-claim-service.ts` is the runtime resource arbitration layer. It owns claim, running, waiting, failure, release, heartbeat, and heartbeat-lost transitions for concrete work units. `SessionExecutionCoordinator` calls its lightweight sweep before dispatch and claim attempts so expired executor leases can be observed and their subtasks can be made recoverable.

`src/core/executor-router.ts`, `src/routing/execution-policy-planner.ts`, and `src/core/executor-routing-coordinator.ts` are no longer the active execution path. Treat them as migration reference for logic that is being folded into planner skills; do not add new primary routing behavior there.

Default agent classes and fixed first-pool work units are seeded in `src/executor/agent-class-seeder.ts`: `planner`/`planner-1` and the configured executor agent class/`executor-1`. Existing `executor_profiles` rows migrate into `agent_classes` as `kind=executor`.

When touching dispatch, update focused tests around the active path first: planner skills, work unit claim service, session execution coordinator, execution runtime, and storage migrations. The current regression anchor is `tests/session/planner-work-unit-bugfix.test.ts`.

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
The agent class responsible for durable execution planning after session intake has created or bound a task. In the current code, `PlannerRuntimeService` owns dispatch-intent normalization, subtask planning or recovery, work graph events, and executor work-unit handoff; raw user-input classification still belongs to `IntentOrchestrator` and `SessionIntentApplicationService`.
_Avoid_: leader, router agent, implementation agent, executor

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
