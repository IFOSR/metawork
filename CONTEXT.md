# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

The active natural-language path is `PlanningAgent -> PolicyKernel -> Runtime`. The isolated Codex `PlanningAgent` owns all natural-language semantics and proposes a strict v3 `PlanningAgentPlan`. Its startup context is minimal; bounded read-only stdio MCP tools provide task, current-session, runtime, executor, and bounded v2 migration-audit facts on demand. The deterministic `PolicyKernel` validates or rewrites that plan and returns a `KernelDecision`. Runtime applies an approved new v3 work graph or recovers the existing one, claims an executor `WorkUnit` in approved preference order, and calls `ExecutionRuntime` with a `SubtaskExecutionSpec`.

`src/planning/` owns the PlanningAgent interface (`CodexPlanningAgent`), dedicated Codex runner, Planner MCP, minimal context construction, v3 plan types/schema, catalog-aware validation, and the pure shared work-graph structure rules. Planner timeout, MCP failure, or invalid output after one repair fails closed to clarification; there is no v2 parser, legacy intent route, semantic default, or keyword fallback.

`src/kernel/` owns deterministic policy authorization. It may accept, rewrite, reject, or clarify a plan, but it must not write storage, claim work units, call executors, or send delivery messages.

`src/execution/work-unit-claim-service.ts` is the runtime resource arbitration layer. It owns starting/probe, approved-order claim, running, waiting, failure, release, heartbeat, and heartbeat-lost transitions. It always queries `executor` work units and does not re-evaluate capabilities or perform post-failure AgentClass fallback. Static `AgentClass` data never represents live health; the legacy database `availability` column is ignored.

Migration v21 renamed the complete legacy `subtasks` table to read-only `subtasks_v2_audit` and created a v3-only production table with `required_capabilities_json` and `preferred_agent_class_list_json`. Non-terminal tasks that owned v2 subtasks are parked for explicit natural-language replan; terminal tasks stay terminal and active legacy WorkUnits become `heartbeat_lost`. Runtime never reads the audit table. A task with an existing v3 graph may only resume it through task control; Phase 1 does not replace or merge an existing graph.

The legacy routing/intent subsystem (`src/core/executor-router.ts`, `src/core/intent-orchestrator.ts`, `src/core/semantic-intent-router.ts`, `src/core/execution-planning-service.ts`, `src/routing/execution-policy-planner.ts`, and the `src/planner/` skill subtree) has been fully removed. The active execution path is `PlanningAgent → PolicyKernel → SessionExecutionCoordinator → WorkGraphRuntimeService`; do not reintroduce a parallel routing layer.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions. A missing non-canonical configured default is materialized as an unclassified AgentClass with no routing capabilities, while an existing non-canonical class is not rewritten. On the first startup after this convergence change, legacy fine-grained Codex/Pi capability metadata is irreversibly replaced by the controlled Routing Capability IDs. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. The retired `executor_profiles` table is removed by migration v20.

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
A strict v3 proposal from the PlanningAgent describing intent, target, task control, risk, confidence, clarification needs, and either one non-empty work graph for `plan_work_graph` or `null` for every other action. It has no top-level execution summary. A plan is not executable until the PolicyKernel accepts or rewrites it.
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
The sole execution-structure fact for one task: a DAG of capability-minimal subtasks split at controlled Routing Capability handoffs. Every executable subtask has non-empty `requiredCapabilities` and a complete ordered `preferredAgentClassList` of all statically eligible canonical AgentClasses. Runtime currently consumes the graph serially; dependency-result injection and concurrency are later phases.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**SubtaskExecutionSpec**:
The runtime input shape for executing a claimed subtask: subtask, executor work unit, agent class runtime configuration, task context, expected output, and acceptance requirements.
_Avoid_: ExecutionPolicy, primaryExecutor, candidateExecutors, fallbackChain

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
