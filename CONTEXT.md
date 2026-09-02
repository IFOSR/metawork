# MetaWork Planning Agent And Work Unit Context

MetaWork is the proprietary commercial product represented by this repository.
AnyFusion is a separate open-source upstream/component family; concrete names
such as `AnyFusion-Pi`, `AnyFusionPlanningAgent`, protocol IDs, database names,
and compatibility settings remain unchanged where they are runtime contracts.

This document defines how MetaWork turns user intent into kernel-authorized
task, subtask, and work-unit runtime actions. It exists because earlier routing
layers conflated intent understanding, policy authorization, task state
changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

Phase 6 established the durable attempt, publication and recovery substrate, and
ADR-0037 now extends it to parallel top-level Tasks across Conversations. The
active path remains `event -> durable inbox -> KernelWorkflow -> snapshot -> ControlKernel.decide -> immutable decision ledger + application -> durable dispatch items -> attempt supervisor -> normalized observation inbox`. `KernelWorkflow` serializes authorization and application, while independent top-level Tasks from different Conversations may run concurrently within configured account limits. A Conversation has one durable execution slot; its later Tasks queue and never overlap its executing or cleaning-up Task. Every attempt owns a Task-generation/Subtask Git worktree that persists across retry, fallback, takeover and merge repair. The default backend runs the canonical Codex/Pi CLIs as child processes in those worktrees; the Docker attempt backend remains an explicit compatibility mode. The isolated AnyFusion-Pi `PlanningAgent` owns user conversation, read-only queries and natural-language planning semantics; `ControlKernel` owns scheduling, cancellation and recovery policy, and Execution owns WorkUnit claims, leases, backend runtimes and Git side effects. See ADR-0037 and the active implementation plan for the multi-Conversation rollout.

`src/planning/` owns the PlanningAgent interface (`AnyFusionPlanningAgent`), controlled-lifecycle AnyFusion-Pi JSONL RPC runner, the structured proposal contract, and catalog-aware validation. One Conversation maps to one persisted Pi session file. Semantic turns use `--mode rpc` over stdin/stdout JSONL and serialize writers per Conversation; MetaWork does not replay SQLite interaction history into prompts. Stable instructions and one fixed `metaclaw-planner/SKILL.md` live in the AnyFusion-Pi fork, while dynamic Task, runtime, authorization and routing facts come only from seven allowlisted read-only MetaWork MCP tools. Semantic RPC turns additionally expose Pi-native read-only `web_fetch` and `web_search` for bounded credential-free public HTTP(S) information, plus the native proposal tool; Pi-native `read`, `grep`, `find` and `ls` are disabled in this mode. The interactive client-only TUI may retain those read-only repository tools for workspace questions; shell, edit and write remain disabled. New semantic Planner proposals may not use `direct_reply`: work-like requests must use `plan_work_graph` and a Kernel-authorized Executor, while historical direct-reply records remain readable for audit and replay. Slash-prefixed system commands stay on the Application-Shell path. Real-time/source-dependent facts require a Web tool call first when they are inputs to an Executor-owned result. Shell execution, unavailable Workspace inspection, file/Git/storage mutation, authenticated external actions, other side effects, durable progress, monitoring, artifacts and downstream handoffs require `plan_work_graph` and a Kernel-authorized Executor. This remains semantic Planner policy, not Session/Kernel keyword routing. MetaWork remains the only v8 validator and the only owner of Task, Kernel, Executor and storage mutation. Pi submits `PlanningAgentPlan v8` only through its restricted native `submit_planning_proposal` tool. Runtime injects session, turn, user input and deterministic submission identity; the model supplies only `plan`. A rejection remains ordinary structured tool feedback in the same ReAct turn, with no proposal-specific retry count, repair prompt or outer coordination loop. `src/work-graph/` owns the shared v7 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Transport uncertainty is distinct from validation rejection and is resolved only by idempotently replaying the identical submission; there is no assistant-text envelope parser, earlier-schema production parser, legacy intent route, semantic default, keyword fallback or Codex Planner fallback.

The default local Client is the pinned `AnyFusion-Pi` fork vendored under `planner/AnyFusion-Pi` (checked into this repository, not a separate clone). Native macOS installation builds MetaClaw and Planner in separate dependency trees and runs them as isolated Node 22.19+ processes; the optional Linux container runtime preserves the same process boundary while sharing one image-level Node executable. `metawork server start` owns the persistent Runtime process and never launches a Client. Bare `metawork` is `metawork tui`: the interactive Pi process reads the Server endpoint manifest, starts with `--gateway-socket` plus an optional stable Conversation ID, submits versioned commands, renders ordered safe events, and never constructs or calls a local semantic runtime. `metawork web` only validates the same Server and opens its loopback origin. Client exit never stops Server work. Semantic Planning remains server-side. `src/tui-bridge/` exposes AnyFusion Planner Host Protocol v2 over a mode-`0600` Unix JSONL socket only for controlled RPC Planner proposal tools. MetaClaw injects an absolute Node command and compiled `planner-mcp.js` arguments; the Planner artifact carries no private Node runtime and never substitutes an uncontrolled executable. A missing fixed query tool fails before the first turn. A mid-turn MCP transport loss locks proposal submission and aborts that agent loop; the Conversation remains attachable and a later turn reconnects through the controlled process boundary. Permission requests cross the Gateway as transient bounded facts; the client submits only request ID plus approve/deny as a versioned `permission_resolution` command. Permission arrival and resolution do not create a semantic Planner turn. `ConversationSession` reruns the v8 schema and semantic validation before emitting `plan_proposed` into `DurableKernelWorkflow`. The first accepted proposal locks the turn; rejected revisions remain open, identical submissions replay their persisted result, and a different post-acceptance submission conflicts. Neither Gateway clients nor the Planner Host bridge can directly access the database, Kernel, scheduler or Executor. Planner cannot synthesize privileged commands, edit, execute shell, mutate Task state, authorize work or publish Git changes. Executor attempts use trusted existing Codex/Pi CLI binaries with MetaWork-only attempt homes in the worktree backend, or canonical Codex/Pi attempt images in Docker compatibility mode. The original Ink implementation under `src/tui/` remains intact as an explicitly unmaintained standby module selected with `METACLAW_STANDBY_TUI=1`; any future activation must remain Gateway-backed.

Only the persistent Server acquires `runtime.lock`. After account recovery and
transport readiness it atomically publishes a mode-restricted endpoint manifest
containing safe PID, version, protocol, Unix socket, loopback Web origin and
ready/draining facts. The manifest never contains a user Workspace. Clients
validate that manifest and fail with an explicit `metawork server start`
instruction when no compatible ready Server exists.
Native update/rollback acquires that same physical lock before migration or
pointer switching. Account migration uses SQLite online backup so committed WAL
data is included, activates a verified staging tree atomically, and moves legacy
state into the rollback archive so it cannot remain a second write authority.
Planner Host startup probes an existing Unix socket and refuses to replace a
reachable listener; shutdown tracks the created socket device/inode and
preserves a replacement path. Structured Planner `transport_uncertain` results
retain their turn, submission, replay identity, concrete redacted message and
partial tool audit instead of becoming a generic missing-acceptance warning.

Account periodic recovery is owned by `AccountRuntime` and runs through a
system binding resolved from durable Task/decision Conversation identity; it
does not require or scan open Conversations. Gateway stale cursors reset to a
bounded current/terminal snapshot and replay only events after that snapshot.
Shutdown closes admission, drains attachments/commands/timers/cancellation
retry work, then closes Planner, Executor and account storage.

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

The public execution stream carries stable turn-local `cursor`, `eventKey`,
Task/Subtask/attempt identity, bounded safe summaries and ordered
deduplication fields. Attempt-runtime progress history is separate from
Completion Protocol evidence: it may rebuild a user-facing detail stream but
never certifies a result. Web renders one inline `LIVE EXECUTION` panel with
one card per Subtask and retains it as `EXECUTION SUMMARY`; a selected card
opens a replayable detail drawer. Historical Web turns persist the safe trace
and durable ExecutionProjector timeline, so reconnect and Conversation
switching do not fall back to only the latest turn or current in-memory trace.
Work Graph owns the pure proposal-to-Runtime canonical Subtask identity map;
Runtime materialization and every Management replay/live projection use that
same map, without title, order or suffix guessing. Configuration owns
revision-pinned public routing identity resolution. Ordinary Web projections
show the Provider catalog label, configured model ID, Executor and Harness
display names, while internal model/provider refs, configuration revisions and
binding fingerprints remain server-side. If a historical revision cannot
recover a public model identity, the projection reports that the historical
model information is unavailable instead of exposing the internal ref.

Public attempt timelines retain the internal `attemptId` only as a non-visible
correlation key. Visible execution narrative uses attempt kind/ordinal labels
such as `主执行` and localized display status such as `已完成`; raw statuses such
as `terminal` are not presentation text. Active attempt duration advances from
its start time; a settled attempt freezes at the immutable receipt completion
time instead of continuing to grow in the UI. The Composer exists only in the
Conversation tab, while App-owned draft and attachment state survives a switch
to the read-only Trajectory tab. Web theme preference is client-only,
persisted under `metawork.theme`, and supports system, light and dark modes
through semantic CSS tokens without changing Gateway, Kernel or Executor
behavior.
Native Planner/TUI and Feishu consume the same passive trace events; Feishu
coalesces ordinary progress and flushes blockers/publication/completion
milestones immediately.

Dependency publication readiness is an explicit Runtime fact. Pending
publication waits, while missing handoff/result/workspace state and identity
mismatch produce bounded structured diagnostics. A blocked Task can resume only
through the Kernel `task_resume_requested` event and `resume_task` decision;
manual, material, contract and unknown blockers remain blocked until explicitly
resolved. Executor connection failures, including generic Provider messages
such as `Connection error.`, normalize to a retryable network failure. During an
explicit Resume only, Runtime may re-normalize the bounded safe summary from the
latest immutable receipt when that receipt was stored by an older release as
`unknown`. If and only if the summary now unambiguously normalizes to `network`,
Runtime submits `task_resume_requested` with blocker category `retry`. It does
not rewrite the receipt or Kernel ledger, does not relax permission, material,
contract or external-effect recovery, and `ControlKernel` remains the sole
authority for `resume_task`. Task and Subtask state restoration is applied only
with the Kernel decision. A legacy `authorize_task_plan` application made uncertain solely by
the former system-binding `onDecisionApplying` presentation callback defect is
the one bounded exception to ordinary manual uncertainty handling. Startup
recovery or an explicit Resume may submit a deterministic
`recovery_resolution_requested(retry)` only when the exact error, submitted
generation replan request, generation identity and adjacent graph revision all
match. ControlKernel still authorizes the retry; no other uncertain application
or external effect is retried automatically.

Task-control command acknowledgement is not execution authority. `/task resume`
reports that execution started only after the first authoritative Kernel Decision
is `resume_task`; `no_op`, `block_work`, and `park_for_replan` report that no new
Executor was launched and retain the Decision reason. The command result may
coexist with later Task/Executor trace, but `Command completed` alone never means
that a Task resumed or completed.

Planner convergence is bounded independently from the wall-clock RPC timeout.
Runtime, Kernel, recovery, scheduling and Executor semantics come only from the
seven authoritative MCP queries and the live proposal schema; Planner may not
inspect MetaClaw source, tests or ADRs to reverse-engineer those semantics. A
turn that exceeds eight processing cycles or twelve non-proposal tool calls
without submitting a proposal fails closed with an explicit terminal error
instead of waiting for the full RPC timeout.

Task control remains current-turn explicit. Topic overlap, an existing blocked
or parked Task, and single-active-Task admission pressure do not authorize
Planner to resume, recover, clear, cancel or repurpose that Task. When such a
Task conflicts with newly requested schedulable work, Planner asks one bounded
clarification rather than performing an implicit state change.

Web presents those facts through the unified Gateway-backed Conversation
workspace. Historical Conversations retain stable Planner identity and bounded
safe projections; attaching a Web client opens or resumes the corresponding
`ConversationSession` without constructing a Web-owned Runtime. Conversation
and Trajectory remain two views of the same trace and execution projection;
neither owns routing or execution.

Live delivery is origin-scoped under ADR-0036. Detailed turn events
(`turn_started`, `trace_delta`, `task_projection`, `execution_delta`,
`permission_request`, `artifact`, result delivery events, `final_answer`,
`terminal_error`, and turn-scoped `delivery_status`) stream only to the
authenticated connection that initiated the turn; Conversation snapshots and
history pages are attach/replay/read projections rather than cross-client live
notifications. A detailed event without a live origin — a startup recovery
projection or a background Task fact after the originating client is gone — is
durable history only and is never broadcast to every Conversation attachment.
Replay remains Account/Conversation complete and origin-unfiltered, so Web,
Feishu and TUI all recover every authorized turn after attach, refresh, switch
or reconnect. Workspace directory activity remains a bounded shared summary,
not a detailed Conversation stream. Turn origin is internal delivery metadata
only and never Account/Conversation authorization or Conversation ownership.

## Account Runtime And Unified Gateway

ADR-0031 was implemented on 2026-08-19. Production startup constructs one
`RuntimeRegistry`, one `AccountRuntime` for `local-default`, one
`WorkspaceDirectory`, one `ConversationRegistry`, and one transport-neutral
`ClientGateway`. Production
client adapters do not construct `MetaclawSession`; that class remains only as
a compatibility/test shell while its standby Ink source is preserved.

The active ownership hierarchy is:

```text
ServerProcess
  -> RuntimeRegistry
    -> AccountRuntime
      -> WorkspaceDirectory
        -> Workspace
          -> ConversationRegistry references
            -> ConversationSession
              -> ClientConnection
```

TUI, Web conversation, Feishu and Unix clients use one versioned Gateway
command/event plane; a future App targets the same contract. The same
authenticated Account shares
configuration, memory, Task, Kernel, Executor, recovery and durable account
facts through one AccountRuntime. Conversations remain separate: each owns one
stable Planner session, serialized input mailbox, safe trace and presentation
state. Sharing an Account never implicitly merges Planner history.

Runtime-wide KernelWorkflow, Execution Runtime, startup recovery, attempt,
publication and timer services are single-owner AccountRuntime services. One
account-scoped Kernel coordinator is the only Application-layer drainer of
durable Kernel events and applications. AccountRuntime scheduling is
Account-wide, but each Conversation owns one durable Task execution slot;
different Conversations may run in parallel and same-Conversation Tasks queue.

Accounts use physically separate data roots and SQLite databases. The existing
installation migrates transactionally into the reserved `local-default`
Account; runtime dual-read and dual-write compatibility paths are forbidden.
See `docs/adr/0031-account-runtime-and-unified-client-gateway.md`,
`docs/plans/2026-08-18-account-runtime-unified-gateway-design.md`, and
`docs/plans/2026-08-18-account-runtime-unified-gateway-implementation-plan.md`.

ADR-0034 makes the process topology explicit. ADR-0035 makes Workspace a
first-class Account-scoped product container with immutable `workspaceId`.
Server startup is
Workspace-neutral and persistent; TUI and Web are independently launched
Clients, and configured Feishu connectivity is owned by Server with no
standalone command. Existing Conversations restore their immutable Workspace
binding. Local Client cwd is an untrusted Workspace selection hint.
`/workspace <path>` selects the Client or platform binding's active Workspace
and never reparents a Conversation after its first ordinary Query. New
Conversations are created in the selected Workspace. TUI, Web and Feishu share
one bounded Workspace Conversation Directory; detailed history, trace and
results remain Conversation-scoped and require attach. Each admitted Turn
retains its authorized `workspaceId` and canonical path.

`src/kernel/` owns the pure `ControlKernel` and the deep control-loop interface. Kernel contract v5 includes the executor-recovery and deferred-availability lifecycle in addition to the Phase 6 dispatch, cancellation, publication and permission contracts. `ControlKernel` reads no time, IDs, repositories, adapters or raw logs. Storage and Runtime implement the ledger and apply seams from outside the Kernel module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. A successful primary/correction attempt commits an immutable receipt and candidate Git commit, then moves the Subtask to `awaiting_integration`; it does not publish result, artifacts, handoffs or `done`. The publication worker integrates candidates in topology/first-dispatch/Subtask-ID order and atomically publishes all completion facts only after Git succeeds. Every non-success commits a terminal receipt and returns control to Kernel policy. A first completion-contract failure may receive one response-only correction on the same AgentClass; merge conflicts instead use the original AgentClass for up to three isolated `merge_repair` attempts, followed by one conflict-chain Planner replan and then park.

Executor path invariant: the Planner-projected `workingDirectory` and `targetPaths` identify the task-owned Git worktree, while each Executor also needs a private runtime home for provider configuration, tools, and sessions. These are separate path contracts. A future Executor registration entry must declare or derive both contracts and must let the adapter materialize them before process launch; it must never rely on a CLI's implicit `HOME` discovery. For Pi, the adapter must set `HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` and pre-create the session directory. For Codex, the adapter must set an isolated `CODEX_HOME` containing the rewritten provider config. The child process `cwd` remains the Planner-assigned worktree. Startup should fail with a path-specific diagnostic if either the worktree or private runtime home is missing. On native and worktree-container launches the drivers seed that private home from the operator-managed templates (`METACLAW_EXECUTOR_CODEX_HOME`, `METACLAW_EXECUTOR_PI_HOME`) and inject provider credentials from the assigned env files (`METACLAW_CODEX_EXECUTOR_ENV_FILE`, `METACLAW_PI_EXECUTOR_ENV_FILE`); the host environment whitelist never forwards `OPENAI_*` on its own.

The unreleased product uses SQLite schema version 37. Fresh databases start at v37; supported pre-release databases migrate transactionally through v31→v32→v33→v34→v35→v36→v37 on a verified clone while unsupported older schemas are refused. Schema v37 permits image preview kinds in the durable `task_artifacts` table. The migration converts active/recoverable Planning and Work Graph payloads from v7/v6 to v8/v7, including revision-pinned `executorBindings`, while terminal Kernel ledger history remains immutable. Any ambiguous recoverable payload rolls the cloned migration back and refuses activation; runtime has no earlier-schema read fallback. Schema v32 added immutable Result Objects and edge-scoped ResultReferences; schema v33 adds the Planner proposal configuration-revision pin used by replay and recovery. `awaiting_decision` and `awaiting_integration` remain Subtask-only states; startup recovery reconciles applications, child items, cancellation cleanup, execution-backend records, leases, publications and result delivery before accepting input. The physical names `attempt_sandboxes`, `sandbox_container_id` and `sandbox_lost` are retained only as durable schema/event compatibility names; new TypeScript abstractions use Execution Backend terminology.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The target active path is `PlanningAgent/Application Shell → KernelWorkflow → ControlKernel → idempotent Runtime handlers → SubtaskAttemptRunner`; do not reintroduce a parallel strategic interpreter or allow a workflow framework to own domain retry policy.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions, including permission-profile bindings and the image fields used by Docker compatibility mode. Custom classes without a valid runtime command/permission profile remain audit-visible but fail closed. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. `ExecutorRegistry` resolves every executable AgentClass through the backend-aware `BackendExecutorAdapter`; the worktree backend is a trusted native process path, not a second semantic executor router.

The canonical `pi-agent` AgentClass is a composite Executor implementation:
ordinary Subtasks run the operator-provided standard `pi --mode json`, while
validated image-generation/image-editing Subtasks run MetaWork's Image API
Runner with the same Kernel-authorized binding. The Runner is not a user-visible
AgentClass and does not use the vendored AnyFusion-Pi Planner or its image mode.
Native Pi upgrades therefore do not overwrite MetaWork image execution code;
Docker remains an explicit compatibility path that packages the Runner into the
attempt image.

Executor recovery is event-driven rather than periodic. `ExecutorRecoveryRefreshService` inspects only enabled AgentClasses whose persisted health is already `error`, coalesces concurrent checks for the same class, records a bounded redacted recovery audit and permits only `error -> healthy`; `disabled` never auto-recovers. Planning and recovery refresh run concurrently, but Kernel admission waits for both. If a relevant class recovers, the proposal may be revised once in the same persisted AnyFusion-Pi session. An existing Task with no usable eligible class persists its latest proposal as `waiting_for_availability`; a later `executor_recovered` fact lets Kernel re-admit the proposal and move the Task to `ready` without another model call or immediate dispatch.

When touching dispatch, update focused behavior tests around `ControlKernel`, `DurableKernelWorkflow`, the decision/application ledger, work-graph runtime, work-unit claims and attempt landing. Attempt terminal regressions remain anchored in `tests/execution/subtask-attempt-runner.test.ts` and `tests/session/planning-agent-session-routing.test.ts`.

## Current Server Upgrade Baseline

The current implementation uses PlanningAgentPlan v8, Work Graph v7, Kernel wire
v5 and SQLite schema v32. ADR-0027 through ADR-0030 govern the configuration
and release baseline; ADR-0032 governs Completion Protocol v4 and result-first
delivery.

ADR-0033 adds the delivered hot-activation and Auto-routing invariant:
AccountRuntime accepts Provider/Model/AgentClass policy changes only while the
activation gate is idle, and the backend rechecks the gate while holding one
activation mutex. A successful activation updates the next Planner turn and
new generation/attempt only; existing generations retain their immutable
configuration revision and concrete binding. Auto is never persisted as an
executable binding: Planner and ControlKernel resolve a concrete
Provider/Model/AgentClass/Harness/Permission Profile/revision tuple before
execution. `WorkGraphPresentationProjector` and Web Work Graph panels are
presentation-only projections of validated graph and durable runtime facts;
they cannot schedule, cancel, retry, fallback, mutate bindings, or access
storage directly.

The active settings contract is Provider-first. Models added to a Provider
catalog form the global candidate source; the settings page does not expose a
separate user-editable Model Facts resource. Planner is fixed-only and must be
manually assigned one catalog model. Codex Executor Auto projects GPT-family
models across enabled Providers, while Pi Executor Auto projects all enabled
Provider models; both policies are narrowed by the user's allowed pool before
`AutoModelResolver` produces a concrete binding. An Auto
`defaultModelRef` is a ranking preference, not a pre-authorized final binding;
mandatory model capabilities derived from the Subtask's Routing Capabilities
filter the allowed pool first. `image-generation` and `image-editing` are
controlled Routing Capabilities derived only when the Executor's effective
model pool contains models with the corresponding structural capabilities.
Kernel therefore selects an image-capable model for image work and rejects
ordinary models even when one is configured as the Auto default.
Provider/model deletion is
allowed only while idle, removes deleted references from Auto pools, and leaves
deleted Fixed references empty until the user repairs them. Invalid drafts never
activate, and busy activation returns `runtime_busy`. Each enabled Executor
AgentClass also has one independent revision-scoped capability profile. The
profile is compiled from its effective fixed/Auto ModelPolicy, current Model
capability evidence, controlled Executor affordances, configured declarations,
and user semantics. The Chinese Skill-style manual, read-only tags, capability
evidence, routable capabilities, preferences, and Routing Catalog entry all
come from that same profile and source fingerprint. The final manual is
Planner's authoritative semantic routing profile; the Catalog is its
machine-readable validation projection. User source text is authoritative
configuration input and is immediately preserved in the settings draft after
deterministic schema and sensitive-content validation. Every changed semantic
payload, including clearing existing guidance, must carry a server-issued
receipt bound to its exact source and assertions before activation. Clearing is
normalized deterministically and does not invoke the Planner model.
Model-assisted extraction may additionally
produce normalized assertions; when present, user semantics take precedence
over conflicting generated positioning and preferences. A supported capability
may be preferred, allowed, avoided, or disabled, while unsupported intent
remains visible and cannot become routable.
Configuration turns receive the selected Executor's current manual and model
facts directly, expose only `submit_executor_manual_proposal`, start no Planner
MCP extension, and use a bounded configuration-specific timeout. Unsaved draft
facts may carry a temporary configuration revision, but the Planner process
still launches with the active revision's authorized model, credentials and
runtime home; draft facts never become a runtime binding. Timeout, model
unavailability, missing tool submission without structured semantic output, or
invalid semantic assertions returns a successful `source-preserved` preview
with no assertions instead of returning HTTP 422 or losing the draft. A
configuration model that cannot invoke the native submission tool may return
the same bounded JSON semantic payload as assistant output; the server
validates it through the same trusted profile compiler. Changed non-empty
guidance remains
activation-blocked until semantic normalization succeeds; empty-source clearing
uses the same trusted proposal path and receipt without a model call. The
preview still includes the
original guidance as bounded draft context and recomputes model-derived
capability evidence. The profile can
add or remove actual Routing Capability qualification as effective Models and
user dispositions change, but it cannot widen Permission Profiles, authorize an
unconfigured Model, change dynamic health, or bypass Kernel authorization.
Provider URLs, credentials and commands remain outside the profile.
Native install/update/rollback uses one `~/.metawork` root, immutable
configuration/generated/application revisions, revisioned database files and
durable activation journals. Until an online management transaction can prove
admission closure and dispatch drain, the native updater fails closed when the
Server is running and requires it to be stopped before pointer mutation.
`metawork build` is the directory-independent source build and activation
entrypoint. It reads one installation-level source checkout record, rebuilds
Runtime, Planner and Web, generates a unique release identity and activates one
coherent `app/current` release through the native update transaction. It never
starts Server or a Client and fails closed while Server is running. Server
publishes that release identity in the endpoint manifest; TUI and Web reject a
different or missing Server identity before opening a Gateway connection.

Application releases and activation journals remain installation-global.
Database, configuration, SecretStore and generated-runtime authority is
account-scoped. Clean install writes directly to `local-default`; an existing
legacy installation is migrated once before update/rollback, and later
transactions never switch the legacy global database/configuration/generated
pointers.

The active static configuration path is:

```text
~/.metawork/accounts/local-default/config/active
  -> one immutable revision directory
  -> config.yaml plus immutable Planner/Kernel/Runtime projections
~/.metawork/accounts/local-default/generated/current
  -> revision-scoped generated Agent runtime
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

Planner launch follows the same revision-pinning rule. For every semantic turn,
the Planner supervisor resolves the generated Planner home for the request's
exact `configurationRevision` before considering legacy environment overrides,
injects the authorized Provider credential from SecretStore, and queries the Pi
RPC state before sending the user prompt. If the restored provider/model differs
from the authorized Planner binding, the turn fails closed and no model request
is sent. Persisted Planner sessions remain in the account/runtime data path and
may survive configuration changes; session history is not allowed to restore an
unauthorized model.

The authorized execution identity is the complete AgentClass/Harness/Model/
Permission Profile/revision tuple plus generation, Subtask and attempt kind.
Provider, Model, AgentClass and binding health are dynamic Kernel-owned facts
identified by revision or immutable binding fingerprint. Runtime and adapters
only normalize probe/attempt facts; Kernel alone owns health interpretation,
retry, fallback and recovery decisions. Permission rule grammar remains
code-owned by Resource/Kernel policy under ADR-0024; configuration can reference
only registered profiles and bounded parameters.

The delivered database change is one transactional schema 30-to-31-to-32-to-33 migration
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

**Account**:
The durable security and state namespace accepted by ADR-0031. It owns
configuration, memory, Tasks, Kernel facts, Executor runtime state, Planner
sessions, Conversations and an isolated data root. This is a target contract
implemented by the account-scoped production composition.
_Avoid_: transport user ID, chat ID, browser cookie, client connection

**AccountRuntime**:
The single live application/runtime coordinator for one loaded Account. It owns
account-wide Kernel sequencing, Task admission and scheduling, Execution
Runtime, recovery, timers and the Conversation registry. Different
Conversations may have active top-level Tasks concurrently within configured
account limits; each Conversation permits only one executing or cleaning-up
top-level Task.
_Avoid_: conversation, MetaclawSession, Web tab, Gateway connection

**Conversation**:
A durable interaction thread inside one Account with one stable Planner session
identity, serialized input mailbox and bounded safe presentation history.
Conversations share account Task/runtime facts but do not implicitly share
Planner history.
_Avoid_: Account, Task, socket, Feishu user

**ConversationSession**:
The live Application-Shell object for one Conversation. It owns Planner turn,
focus, output and safe trace projection, and uses narrow AccountRuntime ports.
It does not construct Kernel, recovery, scheduling or Executor services.
_Avoid_: AccountRuntime, WorkUnit, Task runtime

**ClientConnection**:
A transient authenticated attachment from TUI, Web, Feishu or a future App to
one Account and optionally one Conversation. Disconnect does not destroy the
Conversation or AccountRuntime.
_Avoid_: Conversation, Planner session, Account

**Web Attachment**:
An authenticated, Conversation-scoped image or text upload. The Web client sends
the `File` directly to Management; Management streams it into a temporary
file, computes size and SHA-256 incrementally, sniffs only the leading
signature bytes, and atomically publishes the data plus metadata after the
stream completes. There is no fixed 10 MiB image or 5 MiB text application
limit. Filesystem capacity, deployment quotas, and downstream Provider or
model limits may still reject a later operation explicitly.
_Avoid_: Planner RPC event payload, Workspace mutation, Provider upload

**Gateway**:
The sole accepted user-message connectivity plane under ADR-0031. It
authenticates a Principal, resolves Account and Conversation identity, admits a
versioned command and streams sanitized ordered events. The current
production surfaces all use this Gateway contract.
_Avoid_: semantic router, Runtime owner, Executor transport, shared Session

**Task**:
A durable top-level unit of user work. Its owner tuple is immutable and includes
Account, Conversation, Workspace, Planner session and generation identity.
Independent Subtasks inside one Task may execute concurrently. A Conversation
may execute or clean up only one top-level Task at a time; Tasks from different
Conversations may run concurrently. The Task's Conversation slot remains
occupied while cancellation, publication, container, WorkUnit or lease cleanup
is active or uncertain.
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

**Executor Capability Manual**:
The revision-scoped, Skill-style Markdown routing guidance for one Executor
AgentClass. It is generated from that Executor's current effective Models and
structured routing facts, then semantically merged with persisted user
assertions. It is not a shared Executor document and is not execution
authority.
_Avoid_: global executor profile, permission policy, model authorization

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
The sole execution-structure fact for one task generation: a v7 revisioned DAG pinned to one configuration revision, with capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every node declares its primary delivery channel (`edit` for Workspace/file delivery, `report` for report/answer delivery); both kinds may create ordinary user-space files, including Workspace files and research intermediates. It carries ordered complete Executor bindings rather than free-form class preferences. Every edge has one to twelve keyed `text` or `artifact` items; only published direct-edge handoffs and controlled task evidence enter downstream context. A pure function derives the runnable frontier without persisting an execution layer. Kernel may authorize up to four independent nodes in one deterministic batch; retry, fallback, continuation, merge repair and bounded replans remain Kernel policy.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing requirements, Planner-selected evidence, Planner-selected historical Artifact inputs, sibling titles marked out of scope, workspace boundaries, the completion-report contract, and evidence-tool availability. Historical `artifact` ContextRefs are selected by Planner semantics, validated by MetaWork against Account/Conversation/Workspace/status/source/hash facts, and materialized into the attempt-local input directory before execution. Runtime retains Task/Subtask/attempt/WorkUnit identities and all acceptance/handoff keys outside model output.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Planner Context Bridge**:
A bounded, read-only MetaWork projection exposed through the existing Planner MCP
queries. It supplies current Conversation facts about interactions, Tasks,
Executor results and published Artifacts; it does not perform semantic search,
resolve natural-language references or choose a ContextRef. Pi session history
owns semantic continuity, Planner selects stable references, MetaWork validates
identity/availability/hash, and Runtime materializes only selected inputs.
_Avoid_: semantic router, vector search, transcript replay, Executor database access

**Completion Protocol**:
The active Executor response contract is Completion Protocol v4. A non-empty
Markdown body may be followed by strict identity-free completion metadata, but
body delivery and completion certification are independent axes. Missing or
malformed marker/trailer, evidence cardinality/length, ordinary duration and
physical transport limits may leave a safe body `partial` and `uncertified`;
they must not discard it. Runtime computes one authoritative workspace delta
before certification, retains internal identities outside model output, and
derives artifacts from created/modified files. Ordinary Workspace and user-space
file operations are allowed for Executor work; system-control access, credential
exposure, privilege changes, device or Docker control-plane access and
unauthorized ResultReference access remain fail-closed.
Image generation and editing Subtasks require `deliveryKind: edit` and at least
one PNG, JPEG, WebP, or GIF artifact whose bounded signature read matches its
extension; `report`, missing, unreadable, or forged image outputs cannot certify.
Raw output, business result and safe projection are separate immutable Result
Objects; clients receive the safe projection through bounded Gateway chunks.
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
