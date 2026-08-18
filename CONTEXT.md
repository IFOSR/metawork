# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

Phase 6 is complete at the single-Task boundary. The active path is `event -> durable inbox -> KernelWorkflow -> snapshot -> ControlKernel.decide -> immutable decision ledger + application -> durable dispatch items -> attempt supervisor -> normalized observation inbox`. `KernelWorkflow` serializes authorization and application, while up to four child attempts may run asynchronously inside the one admitted top-level Task. Every attempt owns a Task-generation/Subtask Git worktree that persists across retry, fallback, takeover and merge repair. The default backend runs the canonical Codex/Pi CLIs as child processes in those worktrees; the Docker attempt backend remains an explicit compatibility mode. The isolated AnyFusion-Pi `PlanningAgent` owns user conversation, read-only queries and natural-language planning semantics; `ControlKernel` owns scheduling, cancellation and recovery policy, and Execution owns WorkUnit claims, leases, backend runtimes and Git side effects. ADR-0011 remains an intentional product boundary; multi-top-level-Task scheduling belongs to a future independent roadmap.

`src/planning/` owns the PlanningAgent interface (`AnyFusionPlanningAgent`), controlled-lifecycle AnyFusion-Pi JSONL RPC runner, the structured proposal contract, and catalog-aware validation. One live MetaClaw session maps to one persisted Pi session file. Non-interactive surfaces use `--mode rpc` over stdin/stdout JSONL and serialize writers per session; MetaClaw does not replay SQLite interaction history into prompts. Stable instructions and one fixed `metaclaw-planner/SKILL.md` live in the AnyFusion-Pi fork, while dynamic Task, runtime, authorization and routing facts come only from seven allowlisted read-only MetaClaw MCP tools. Pi also exposes only `read`, `grep`, `find` and `ls` against the directory where the user started AnyFusion; shell, edit and write remain disabled. MetaClaw remains the only v8 validator and the only owner of Task, Kernel, Executor and storage mutation. Pi submits `PlanningAgentPlan v8` only through its restricted native `submit_planning_proposal` tool. Runtime injects session, turn, user input and deterministic submission identity; the model supplies only `plan`. A rejection remains ordinary structured tool feedback in the same ReAct turn, with no proposal-specific retry count, repair prompt or outer coordination loop. `src/work-graph/` owns the shared v7 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Transport uncertainty is distinct from validation rejection and is resolved only by idempotently replaying the identical submission; there is no assistant-text envelope parser, earlier-schema production parser, legacy intent route, semantic default, keyword fallback or Codex Planner fallback.

The default local surface is the pinned `AnyFusion-Pi` fork vendored under `planner/AnyFusion-Pi` (checked into this repository, not a separate clone). Native macOS installation builds MetaClaw and Planner in separate dependency trees and runs them as isolated Node 22.19+ processes; the optional Linux container runtime preserves the same process boundary while sharing one image-level Node executable. `src/tui-bridge/` exposes AnyFusion Planner Host Protocol v2 over a mode-`0600` Unix JSONL socket for both native TUI and RPC proposal tools. Both modes use one Planner bootstrap, fixed Skill, exact tool set and proposal path. MetaClaw injects an absolute Node command and compiled `planner-mcp.js` arguments; the Planner artifact carries no private Node runtime and never substitutes an uncontrolled executable. A missing fixed query tool fails before the first turn. A mid-turn MCP transport loss locks proposal submission and aborts that agent loop; the TUI remains alive and reconnects before the next turn. The TUI receives only Session projections, requests slash-command completion state from `MetaclawSession`, and may transport an explicit user-authored slash command; completion, validation, dynamic Task/Executor candidates and execution still come only from the existing `CommandCatalog`. Host Protocol v2 also advertises backward-compatible `executor_result` and `permission_request` capabilities. Executor results are passive persisted Planner context as described below. Permission requests are instead transient UI-only facts: the Session projects only current-session, applied, unresolved escalations inside the 24-hour validity window; Pi reviews them through a native Selector and submits only request ID plus approve/deny. Interactive Planner authorization proposals and shared `/permission` commands are rejected, while RPC, Feishu and Session Planner exact natural-language authorization remain supported. Permission arrival and resolution never enter the Pi branch or create a semantic turn. `MetaclawSession` reruns the v8 schema and semantic validation before emitting `plan_proposed` into `DurableKernelWorkflow`. The first accepted proposal locks the turn; rejected revisions remain open, identical submissions replay their persisted result, and a different post-acceptance submission conflicts. The bridge has no direct database, Kernel, scheduler or Executor dependency. Planner cannot synthesize privileged commands, edit, execute shell, mutate Task state, authorize work or publish Git changes. Executor attempts use trusted existing Codex/Pi CLI binaries with AnyFusion-only attempt homes in the worktree backend, or canonical Codex/Pi attempt images in Docker compatibility mode. The original Ink implementation under `src/tui/` remains intact as an explicitly unmaintained standby module selected with `METACLAW_STANDBY_TUI=1`.

Every composition mode, including `--script`, acquires the same `runtime.lock`.
Planner Host startup probes an existing Unix socket and refuses to replace a
reachable listener; shutdown tracks the created socket device/inode and
preserves a replacement path. Structured Planner `transport_uncertain` results
retain their turn, submission, replay identity, concrete redacted message and
partial tool audit instead of becoming a generic missing-acceptance warning.

Web exposes a bounded `InteractionTrace` from query intake through Planner,
Kernel authorization, exact authorized Executor bindings, execution progress,
verification and delivery. Session events stream as `trace_snapshot` and
ordered `trace_delta` messages; reconnect receives a full current-turn
snapshot. Planner RPC lifecycle and safe tool milestones are forwarded while
the process is still running, including process start, prompt acceptance,
processing cycles, model stream start, tool start/completion and agent
completion. Existing `ExecutionProjector` remains the durable source for
Subtask, attempt, verification and publication facts. Executor progress is
noise-filtered, redacted and truncated before the existing attempt-runtime
record is updated. The trace is presentation-only and never includes raw
prompts, raw stdout/stderr, credentials, sensitive field names or hidden
chain-of-thought.

Web now presents those facts through a persistent session workspace rather than
a permanent chat/trace split. A file-backed Application-Shell projection under
`~/.anyfusion/data/web-sessions/` stores bounded sanitized terminal turns.
Historical sessions are browse-only until `WebSessionRuntime` passes the idle
Planner/Task activation gate and recreates the one live `MetaclawSession` with
the same stable Planner session ID. Conversation and Trajectory are two views
of the same trace and execution projection; neither owns routing or execution.

`src/kernel/` owns the pure `ControlKernel` and the deep control-loop interface. Kernel contract v5 includes the executor-recovery and deferred-availability lifecycle in addition to the Phase 6 dispatch, cancellation, publication and permission contracts. `ControlKernel` reads no time, IDs, repositories, adapters or raw logs. Storage and Runtime implement the ledger and apply seams from outside the Kernel module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. A successful primary/correction attempt commits an immutable receipt and candidate Git commit, then moves the Subtask to `awaiting_integration`; it does not publish result, artifacts, handoffs or `done`. The publication worker integrates candidates in topology/first-dispatch/Subtask-ID order and atomically publishes all completion facts only after Git succeeds. Every non-success commits a terminal receipt and returns control to Kernel policy. A first completion-contract failure may receive one response-only correction on the same AgentClass; merge conflicts instead use the original AgentClass for up to three isolated `merge_repair` attempts, followed by one conflict-chain Planner replan and then park.

Executor path invariant: the Planner-projected `workingDirectory` and `targetPaths` identify the task-owned Git worktree, while each Executor also needs a private runtime home for provider configuration, tools, and sessions. These are separate path contracts. A future Executor registration entry must declare or derive both contracts and must let the adapter materialize them before process launch; it must never rely on a CLI's implicit `HOME` discovery. For Pi, the adapter must set `HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` and pre-create the session directory. For Codex, the adapter must set an isolated `CODEX_HOME` containing the rewritten provider config. The child process `cwd` remains the Planner-assigned worktree. Startup should fail with a path-specific diagnostic if either the worktree or private runtime home is missing. On native and worktree-container launches the drivers seed that private home from the operator-managed templates (`METACLAW_EXECUTOR_CODEX_HOME`, `METACLAW_EXECUTOR_PI_HOME`) and inject provider credentials from the assigned env files (`METACLAW_CODEX_EXECUTOR_ENV_FILE`, `METACLAW_PI_EXECUTOR_ENV_FILE`); the host environment whitelist never forwards `OPENAI_*` on its own.

The unreleased product uses SQLite schema version 31. Fresh databases start at v31; the sole supported native upgrade source is schema 30, migrated transactionally on a verified clone while ordinary runtime startup refuses schema 30 in place. The migration converts active/recoverable Planning and Work Graph payloads from v7/v6 to v8/v7, including revision-pinned `executorBindings`, while terminal Kernel ledger history remains immutable. Any ambiguous recoverable payload rolls the cloned migration back and refuses activation; runtime has no earlier-schema read fallback. Schema v31 retains persisted Planner proposal turns/submissions and their accepted-turn lock, the Kernel v5 decision/workflow ledger, resource/workspace/permission/execution-backend facts, durable dispatch/publication/merge audit, cancellation cleanup, lease revocation, generation replan requests, deferred availability proposals, bounded Executor recovery checks and `full | partial_accepted` revision completion. `awaiting_decision` and `awaiting_integration` remain Subtask-only states; startup recovery reconciles applications, child items, cancellation cleanup, execution-backend records, leases and publication state before accepting input. The physical names `attempt_sandboxes`, `sandbox_container_id` and `sandbox_lost` are retained only as durable schema/event compatibility names; new TypeScript abstractions use Execution Backend terminology.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The target active path is `PlanningAgent/Application Shell → KernelWorkflow → ControlKernel → idempotent Runtime handlers → SubtaskAttemptRunner`; do not reintroduce a parallel strategic interpreter or allow a workflow framework to own domain retry policy.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions, including permission-profile bindings and the image fields used by Docker compatibility mode. Custom classes without a valid runtime command/permission profile remain audit-visible but fail closed. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. `ExecutorRegistry` resolves every executable AgentClass through the backend-aware `BackendExecutorAdapter`; the worktree backend is a trusted native process path, not a second semantic executor router.

Executor recovery is event-driven rather than periodic. `ExecutorRecoveryRefreshService` inspects only enabled AgentClasses whose persisted health is already `error`, coalesces concurrent checks for the same class, records a bounded redacted recovery audit and permits only `error -> healthy`; `disabled` never auto-recovers. Planning and recovery refresh run concurrently, but Kernel admission waits for both. If a relevant class recovers, the proposal may be revised once in the same persisted AnyFusion-Pi session. An existing Task with no usable eligible class persists its latest proposal as `waiting_for_availability`; a later `executor_recovered` fact lets Kernel re-admit the proposal and move the Task to `ready` without another model call or immediate dispatch.

When touching dispatch, update focused behavior tests around `ControlKernel`, `DurableKernelWorkflow`, the decision/application ledger, work-graph runtime, work-unit claims and attempt landing. Attempt terminal regressions remain anchored in `tests/execution/subtask-attempt-runner.test.ts` and `tests/session/planning-agent-session-routing.test.ts`.

## Current Server Upgrade Baseline

The current implementation uses PlanningAgentPlan v8, Work Graph v7, Kernel wire
v5 and SQLite schema v31. ADR-0027 through ADR-0030 govern this active baseline.
Native install/update/rollback uses one `~/.anyfusion` root, immutable
configuration/generated/application revisions, revisioned database files and
durable activation journals. Until an online management transaction can prove
admission closure and dispatch drain, the native updater fails closed when the
Server is running and requires it to be stopped before pointer mutation.

The target static configuration path is:

```text
~/.anyfusion/config/active
  -> one immutable revision directory
  -> config.yaml plus immutable Planner/Kernel/Runtime projections
  -> revision-scoped generated Agent runtimes
```

`ConfigurationService` belongs to the Application Shell. Planning may consume
only the Planner-safe projection, Kernel only the pure Kernel-safe facts supplied
in snapshots, and Runtime only the private authorized binding. Configuration may
not import Kernel or Runtime policy, mutate durable Task state, or become a
second routing interpreter. Migration prepares an immutable candidate while the
legacy authority remains unchanged, then performs one cutover after every
consumer is ready; dual-read and dual-write paths are forbidden.

One Work Graph generation pins one `configurationRevision`. Every graph revision,
deferred availability proposal, Kernel decision, dispatch item, retry/fallback,
recovery packet, attempt and receipt in that generation remains on the same
revision. An active configuration change affects only a new generation. Runtime
must fail closed rather than substitute the current active revision.

The authorized execution identity is the complete AgentClass/Harness/Model/
Permission Profile/revision tuple plus generation, Subtask and attempt kind.
Provider, Model, AgentClass and binding health are dynamic Kernel-owned facts
identified by revision or immutable binding fingerprint. Runtime and adapters
only normalize probe/attempt facts; Kernel alone owns health interpretation,
retry, fallback and recovery decisions. Permission rule grammar remains
code-owned by Resource/Kernel policy under ADR-0024; configuration can reference
only registered profiles and bounded parameters.

The delivered database change is one transactional schema 30-to-31 migration
covering all new tables, columns, foreign keys, indexes and recoverable v7/v6
payload conversion. The native updater uses an exclusive update lock, WAL
checkpoint, verified database backup, cloned migration, immutable staging,
candidate health checks and crash-recoverable pointer rollback. Bootstrap
verifies the signed manifest before artifact download and verifies each artifact
before extraction or execution. No program release, configuration revision,
generated runtime or database schema may be activated as a mixed-version
combination.

Future A2A support may implement only the existing authorized-attempt transport
seam:

```text
Planner -> ControlKernel -> Execution Runtime -> ExecutorAdapter -> transport
```

It is not part of the current Server upgrade release and may not introduce a
second scheduler, router, retry loop, recovery ledger or Planner-to-Executor
shortcut.

## Routing Language

**Task**:
A durable top-level unit of user work. ADR-0011 admits at most one active top-level Task; Phase 6 allows independent Subtasks inside it to execute concurrently and keeps the Task's single-active slot occupied while cancellation cleanup still owns containers or leases.
_Avoid_: request, prompt, executor run, browser tab

**Subtask**:
A decomposed piece of work inside a Task, planned so it can have at most one pending/active attempt at a time. Its lifecycle is `ready | running | awaiting_integration | awaiting_decision | blocked | done | cancelled`.
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
A strict v8 proposal from the PlanningAgent describing intent, target, task control, risk, confidence and clarification needs. It contains one non-empty v7 work graph only for `plan_work_graph`, or an exact approve/deny resolution only for a pending `authorization_resolution`; all other action-specific fields are null. The graph pins one `configurationRevision`; each node uses structured dependencies, typed context references, keyed acceptance criteria, `deliveryKind: edit | report`, and one or more complete authorized Executor binding candidates. A plan is not executable until its durable event is authorized or rewritten by `ControlKernel` and recorded in the decision ledger.
_Avoid_: runtime command, task event, execution policy

**ControlKernel**:
The pure deterministic v5 decision module for Planning, frontier batch dispatch, capacity, execution outcome, Task/Subtask cancellation, partial-result acceptance, generation replan, deferred availability, Executor recovery, publication conflict, contract failure and timer events. Its only public Interface is `decide(event, snapshot)`.
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
The sole execution-structure fact for one task generation: a v7 revisioned DAG pinned to one configuration revision, with capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every node declares whether it may change the workspace (`edit`) or must remain read-only (`report`) and carries ordered complete Executor bindings rather than free-form class preferences. Every edge has one to twelve keyed `text` or `artifact` items; only published direct-edge handoffs and controlled task evidence enter downstream context. A pure function derives the runnable frontier without persisting an execution layer. Kernel may authorize up to four independent nodes in one deterministic batch; retry, fallback, continuation, merge repair and bounded replans remain Kernel policy.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing requirements, Planner-selected evidence, sibling titles marked out of scope, workspace boundaries, the completion-report contract, and evidence-tool availability. Runtime retains Task/Subtask/attempt/WorkUnit identities and all acceptance/handoff keys outside model output.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Completion Protocol**:
The required final Executor response contract: non-empty clean Markdown followed by exactly one `metaclaw:completion:v3` strict identity-free JSON report containing only `evidence` and nullable `noChangeReason`, or a controlled `failure`. Runtime computes one authoritative workspace delta before completion validation, injects the bound schema/Subtask/attempt/WorkUnit identities, acceptance keys and exact outgoing handoffs, and derives artifacts only from created/modified files in that delta. `report` requires zero delta and null reason; changed `edit` requires null reason; zero-delta `edit` requires a non-empty reason. Truncated or indeterminate delta fails closed. Runtime strips the report from every user-facing and memory-facing result.
_Avoid_: model-supplied identity/key fields, legacy envelope fallback, best-effort trailer, visible machine block

**Execution Evidence**:
The attempt-bound, Task-scoped read-only port for eligible user input, user materials, and confirmed preferences. Ordinary assistant/Executor output and dependency results are not generally searchable; an explicitly authorized assistant interaction is exact-get only.
_Avoid_: conversation transcript, cross-task search, dependency output channel

**Attempt Receipt**:
The immutable terminal audit for one Task/Subtask/attempt/WorkUnit/AgentClass invocation, including attempt kind, provenance, raw response and parsing/verification facts. A successful receipt proves candidate production, not publication or Subtask completion.
_Avoid_: retry state machine, user-visible result, mutable handoff

**Cancellation Fence**:
The durable Kernel-authorized transaction that makes a Task or an atomic downstream Subtask closure non-runnable before Runtime starts physical cleanup. Active dispatch/publication rows remain `cancelling` and continue to occupy capacity until the selected execution backend has exited or is confirmed missing and WorkUnit/resource leases are released. Outcomes arriving after the fence are stale `no_op` facts.
_Avoid_: best-effort process abort, status-only update, rollback of published facts

**Generation Replan Request**:
The one durable ordinary automatic-replan request for a Task generation/revision. Multiple exhausted Subtasks coalesce into it; independent work drains first, Planner runs only at quiescence, and an exact token prevents a cancelled or stale Planner result from superseding the graph.
_Avoid_: conflict-chain replan, per-attempt hidden retry, parallel Planner calls

**Work Unit Event**:
A durable runtime event about a work unit, such as state changes, claims, heartbeats, failures, draining, or stop events.
_Avoid_: TUI output line, transient progress text, task message

**Kernel Executor Status Projection**:
The Kernel-owned, persisted, one-row-per-AgentClass current control-plane view of class health, recent execution outcomes, and bounded redacted recovery checks. AgentClass instances are independently started, so a busy Work Unit does not change this projection; it is not a Work Unit or an execution log.
_Avoid_: AgentClass availability, Work Unit state, executor call log

**AgentClass Health**:
The Kernel's classification of whether an AgentClass itself is usable: unverified, healthy, error, or disabled. `error` is a re-verifiable observation and may recover only through a successful structured recovery probe; `disabled` is the administrative lock and never auto-recovers. A failed executor instance does not change class health unless its cause proves a class-level fault or meets the configured systemic-failure rule.
_Avoid_: Work Unit status, last execution result, capacity

**Recent Recovery Checks**:
The bounded Planner-safe audit of event-driven probes performed only for enabled AgentClasses currently in `error`. Each entry records trigger, time, recovered/still-error/timeout outcome, and a redacted structured failure. It never enters Recent Execution Attempts and never discovers new faults in healthy classes.
_Avoid_: periodic health poll, raw Docker/provider logs, execution attempt

**Deferred Availability Plan**:
The exact latest replan proposal persisted with a `waiting_for_availability` generation replan request after Kernel determines that a current Task has no usable eligible Executor. Recovery re-admits this proposal without another model call; stale/cancelled revisions are no-ops.
_Avoid_: Planner retry loop, blocker-text parsing, immediate dispatch

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
The private `(taskId, generationId, subtaskId)` Git worktree that survives attempt process/container restarts. Git sources are cloned into an internal bare repository; non-Git sources are imported as an immutable initial commit into the same shape. Checkpoint/CAS material supplements Git recovery but is not a second merge authority. Downstream nodes merge only published direct-dependency ancestry.
_Avoid_: user repository, unversioned sibling directory, treating a container as the source of workspace isolation

**Resource Lease**:
The attempt-bound claim over one normalized repository, worktree, mount-relative path, logical resource or external object. It records read/write access, owner, heartbeat, expiry, release and wait relationships; overlapping claims conflict whenever either side writes.
_Avoid_: permanent workspace ownership, WorkUnit identity, host absolute path

**Capability Request**:
An Executor's structured request for one concrete operation outside its default AgentClass permission profile. Runtime canonicalizes it; Kernel v5 alone grants a bounded capability, denies with an Executor-visible reason, or denies and escalates the exact request to Planner/user authorization. A granted request returns an opaque grant ID but does not itself widen execution authority or container sandbox policy. Runtime supplies versioned explicit rules: exact Task-registered read partitions, plus normalized public HTTP(S) targets only for the public-web-research profile; secrets and mutations are never profile-allowed.
_Avoid_: Planner resource claim, stderr parsing, broad permission prompt

**Capability Use**:
One attempt-bound audit-budget consumption of a previously granted capability. The Executor supplies the operation payload; trusted Runtime measures its UTF-8 size and atomically enforces attempt identity, expiry, call and byte budgets. This is not proof of universal operation mediation and does not add fine-grained authority beyond the selected execution backend and permission profile.
_Avoid_: universal capability broker, syscall enforcement claim, caller-declared byte count
