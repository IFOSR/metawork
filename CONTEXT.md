# MetaWork Planning Agent And Work Unit Context

Edge handoff completion invariant (2026-10-28): a Subtask may enter `done` only
when every outgoing Work Graph edge already has its handoff row, written in the
same transaction by the completion boundary. In-place execution no longer
produces a publication, so the publication worker is not the owner of that fact;
`materializeOutgoingHandoffs()` is the single idempotent writer, and a completion
without a safe body fails closed instead of landing `done`. A dependency edge
that can never be materialized is a structural defect: the Kernel spends its one
automatic replan, then blocks with `blockerKind: 'system'` (`needs_action` +
`system_anomaly`, never a user-input request). Pre-fix rows are repaired from the
upstream attempt's certified safe projection. See ADR-0021's 2026-10-28
amendment.

Upstream-input recovery (2026-10-17): explicit Resume may continue a settled
`missing_upstream_input` failure only after current binding/evidence support,
published direct inputs, retained workspace and residue checks. Kernel can
supersede the exact startup orphan fence and retire an identity-matched replan
rejected for invalid context refs; real manual blockers and external uncertainty
remain closed. Completed stages and historical facts are preserved. Replan
proposal validation checks exact evidence IDs in the same Planner turn using a
detached host. New evidence IDs hash the full source; existing refs stay stable.
See ADR-0023 and the blocked-upstream recovery implementation record.

Desktop shutdown recovery (2026-10-17): explicit installer stop captures the
owned launchd Server before invoking the installed stop CLI, including when a
legacy Server has already removed its runtime lock. Activation waits for actual
process exit. Bounded cleanup requires unchanged user/process/job identity,
withdrawn lock and endpoint, and no open account/data files or sockets. Ordinary
connection never terminates a live job. Pi inventory verification runs outside
the connection promise so a ready client can reconnect immediately. See the
Desktop exit recovery implementation record for local acceptance.

Official account authorization (2026-10-09, ADR-0047): the local Server now
owns an in-memory official session and normalized entitlement state. Production
Gateway admission verifies that entitlement online; active work triggers one
Server-level daily check after 24 hours from the last successful verification.
The official reference service is deployed on huoshan and owns account/session
digests, licenses, public plan prices, payment orders and fixed internal
AI operations. Payment settlement and the refund channel (2026-10-14,
ADR-0048) live entirely in the official service: the HMAC-verified gateway
callback is the only authorization basis, settlement is idempotent over
payment-attempt history with exact integer money, refunds are admin-only over
SSH loopback and restore the pre-purchase license revision, and money that
cannot settle persists as `payment_incidents` for manual reconciliation.
Local clients only proxy pay/poll/list; without `PAYMENT_HUB_*` credentials
payments stay closed with otherwise unchanged behavior. Query billing remains
separate. No local session token is persisted, and Server restart requires
official login again. Local Web cookie / Desktop ticket authentication remains
mandatory for official-account routes.
Official AI simplification (2026-10-10): the service authenticates/authorizes the
request, selects a fixed business prompt, calls the configured model with provider
defaults and returns parsed business JSON. It does not impose AI quotas, request
deduplication, concurrency gates, output-token/thinking settings, or duplicate
business schemas/content filters. Local settings consumers own renderable result
validation; deterministic activation and Kernel authorization are unchanged.
Kernel owns the pure production-action policy, applied to every snapshot,
durable decision replay and pending attempt launch. Closed authorization defers
productive recovery while permitting cancellation, terminal observations and
cleanup. Planner queues and account Replan Workers consume the same fact.
In-process account changes cannot inherit unfinished work; live Planner turns,
reservations, leases and publication cleanup must settle before login.
See `docs/current/official-account-operations.md` for migration and deployment.

Managed Pi and optional tools (2026-10-09): Desktop uses its release-managed Pi
Executor entrypoint, independent of the user's global Pi. Codex paths are
validated and activated through the existing strict-idle settings transaction;
probe and execution use the same resolved entrypoint. Missing external tools
do not roll back program updates. Managed tool repair is release-matched,
serialized with the existing update lock and limited to one automatic attempt.
See the managed-Pi plan for implementation and packaged acceptance status.


Desktop first launch (2026-10-08, ADR-0045) initializes without model credentials:
empty Provider/Model catalogs, disabled editable AgentClass presets, and an
explicitly absent Planner binding. The ordinary Server provides Settings and
browsing; Gateway blocks semantic work until configuration activation enables
Planner and Executors. Stable release artifacts may retain an immutable build
identity. Preview artifacts use the ordered SemVer form
`<stable-version>-preview.<n>` (for example `0.1.18-preview.1` and
`0.1.18-preview.2`). Preview numbers are the chronology signal; commit hashes
and local labels are not used to order preview releases. Numeric product
downgrade and compatibility checks remain intact.

macOS Desktop starts updater and Server through one-shot user-session launchd
jobs: detached spawn alone remains inside Finder's application coalition and can
be killed on Desktop exit. No login registration or automatic restart is added;
formal installer/service lifecycle ownership remains unchanged (ADR-0045).
Internal apps receive a valid local ad-hoc seal with the MetaWork identity;
skipping Apple signing must not leave Electron's invalid stub signature. Final
Finder acceptance uses the unchanged package, and respects macOS background policy.

MetaWork is the proprietary commercial product represented by this repository.
AnyFusion is a separate open-source upstream/component family; concrete names
such as `AnyFusion-Pi`, `AnyFusionPlanningAgent`, protocol IDs, database names,
and compatibility settings remain unchanged where they are runtime contracts.

This document defines how MetaWork turns user intent into kernel-authorized
task, subtask, and work-unit runtime actions. It exists because earlier routing
layers conflated intent understanding, policy authorization, task state
changes, subtask planning, executor instance claims, and fallback behavior.

Task execution reliability (2026-10-15): runtime launch validates the authorized
binding fingerprint and generated revision configuration; a protected manifest
records program/configuration/workspace/tool boundaries without credential values.
Container launches probe the executable in the immutable image without Task
mounts, network or credentials, then create the business container by that same
image ID. Host executable availability is not container availability.
Safe text without valid completion metadata is visible but uncertified; only
formatting admits bounded response-only correction. Correction and primary success
both enter Git publication, followed by durable user delivery (schema 49).
`workspace_publication_deliveries` records pending/failed/succeeded plus per-file
projections/failures. Only successful delivery releases Subtask done and downstream
handoffs. Resume uses the existing Kernel route and checks generation/revision;
failed delivery retries files, never Executor work. Legacy publication history is
not backfilled or silently re-published.

Execution boundary and feedback principle (2026-10-27, clarified by ADR-0052):
Planner understands the user goal and produces the Work Graph; Kernel reviews
and authorizes that Graph; Executor/Harness owns the complete internal
execution loop and its tool registry; MetaWork receives the final Attempt fact,
verifies the external postconditions, assembles the Graph result and delivers
it. `workspaceIntent` describes the requested Workspace effect for admission
and verification, but it never becomes a Harness tool allowlist. A normal
Executor keeps its shell and other registered tools available; only an explicit
response-only correction may request a reduced surface. Harness-owned tool
errors, command failures,
test failures, code repair, Provider backoff and multi-turn reasoning must stay
inside the Harness. They are not user decisions and must not be promoted to a
MetaWork terminal failure after the first error. `executor_failed` means that
the Harness has exhausted its current execution loop or hit a non-recoverable
boundary.

When Runtime verification disagrees with an Executor success, the default
interpretation is Mentor feedback, not task failure. Runtime records the real
acceptance failure, Workspace/service facts and bounded diagnostics; Kernel
authorizes a continuation or recovery packet on the original Graph; the same
Executor class receives that feedback and continues repairing and validating.
Hard boundaries remain Workspace containment, authorization/credential and
resource violations, uncertain external side effects and missing user input.
Only those cases, or exhausted automatic repair budget, may require the user.
This feedback path reuses Kernel continuation/recovery and never adds a second
MetaWork Agent Loop or a per-tool approval step.

Explicit file delivery (2026-10-15, ADR-0032 amendment): new Planner proposals
must declare each Subtask's `fileOutputs`. `[]` means inline text/action receipts
or Git edits without downloadable files; relative filenames and dedicated
directory prefixes ending in `/` select required file deliveries. Runtime
matches these declarations against existing regular files, never natural-language
keywords. Missing declared outputs remain uncertified; unsolicited scratch files
are not user artifacts or artifact handoffs. Planner/Executor instructions forbid
extra proof reports for ordinary actions and code edits. SQLite schema 50 adds
nullable `file_outputs_json`; NULL preserves only previously authorized graphs'
delivery semantics. New proposals cannot omit the declaration. Git integration,
safe text visibility, and file-delivery-only recovery retain their existing owners.

## Current Implementation Notes

Long-term memory (2026-10-22, amended 2026-10-26, ADR-0049): long-term memory
is an optional capability backed by one external memory engine behind a single
Memory Port. One MetaWork installation is one local Server for one local
customer, so `MemoryRuntimeController` is Server-owned: the Server composition
creates it once, configuration activation rebuilds it only when the `memory`
section changes, and shutdown stops the AccountRuntimes before the final memory
drain, scheduler stop and sidecar stop. It is not per-AccountRuntime.

The account identity is the durable persistence namespace and future extension
point. Every memory query keeps its `account_id` predicate, and every recalled
asset is validated against the owning account. Workspaces, agent roles and
conversations are provenance labels only. The local `memory_bindings` table
holds ownership, the user switch and a content digest; it never holds a memory
body, so the engine can be discarded and rebuilt without losing the user's
decisions.

Deposition is batched and completed-turns only: a conversation goes idle, and
every turn since the last deposition is written to the L0 conversation layer in
one call, because only the whole segment lets the engine recognize a cross-turn
preference. Turn-by-turn deposition is rejected. Failed, cancelled and blocked
rounds never become durable experience. The deposition cursor advances only
after the engine accepted the batch. A conversation with a completed turn is
also flushed when two hours have passed since the last successful deposition;
a failed deposition never moves that timestamp.

Delivery is pull-only. The Planner references a memory with
`ContextRef{kind:'memory', memoryId}`; the Runtime re-validates account
ownership and the enabled state, fetches the body on the host side, and
materializes it as `task_execution_evidence(kind='long_term_memory')`. The
ADR-0021 budget (4,000 characters per item, 24,000 per task) and the
`executor_evidence_accessed` audit apply unchanged. A memory is never spliced
into the prompt body, and an unavailable memory is an explicit failure rather
than empty content.

The Planner never reaches the engine. The Server owns the adapter and projects a
bounded preview into the account database; the Planner reads that read model
through the `search_memory` and `list_memory_assets` MCP tools, exactly as it
reads tasks and interactions from the database. `search_memory` is not a
full-text search over every asset: it reads the current turn's bounded
candidates and returns the `memoryId` to reference. Engine credentials are read
from the SecretStore on demand and injected into the sidecar environment only;
they never enter the Server `process.env`, which the Planner process tree
inherits, and the Executor container has neither a memory credential nor a
memory network route. The fixed SecretStore user-key reference is an
installation/Server secret, not a per-account credential.

When the runtime is disabled, needs-model or degraded it clears the
conversation's recall candidates and records its mode in
`memory_runtime_state`. The Planner tools gate on that durable mode, so a stale
projection from a previous runtime is never offered, and the management view
reports the degraded reason instead of an empty asset list.

`memory.enabled=false` means no sidecar, no request, no model cost and no
index. The extraction model is chosen explicitly by the user from the providers
they already configured; the system enforces only hard constraints (the
Provider protocol must be `openai-compatible`, the Provider and Model must be
enabled, the Model must belong to that Provider and must declare
`structured-output`) and never recommends, downgrades or fills in a model.

The pre-TDAI local memory chain is retired (schema 59). `MemoryEngine`,
`ContextRecaller`, `MemoryContextService`, the preference repository, memory
vault export, learning/reflection/promotion automation, `/memory`, `/learning`
and profile-preference commands are not production capabilities. The
`preferences`, `preference_usage`, `reflection_events` and `learning_candidates`
tables no longer exist, and `ContextRef{kind:'preference'}` is not a supported
reference: a persisted payload that contains one fails closed and requires a new
plan. The only automatic deposition path is
`MemoryFlushScheduler → MemoryService → MemoryPort → TDAI`; the only long-term
memory planning path is
`refreshRecall → memory_recall_candidates → search_memory → ContextRef{kind:'memory'}`.
Extraction spend belongs to the user-selected Provider.

Deposition is sanitized first: secret-like content is redacted before it
reaches the engine, content whose secret cannot be masked is refused, and
dangerous-command content is marked as sanitized. A re-bind never re-enables
an asset the user disabled.

Degradation never fails a task. An unavailable engine means deposition is
dropped and logged, recall returns an empty result with a `degraded` flag,
materialization fails explicitly, and governance actions report the error. The
engine's BM25 recall depends on SQLite FTS5; without FTS5 the recall silently
returns nothing, so FTS5 availability in the engine health response is a
blocking gate and the memory seam stays closed rather than appearing to work.

The engine is part of the release, not a prerequisite the user installs. Every
release ships the pinned TDAI MemoryCore tree as the signed `memory` artifact
and every installer/updater extracts it to `<releaseRoot>/memory/tdai`, so
`memory.enabled=true` never depends on a separate download while
`memory.enabled=false` still starts no process, sends no request and costs
nothing. The management view distinguishes "engine not installed", "engine
unreachable", "engine unhealthy" and "FTS5 unavailable": only the last one is a
BM25/FTS5 problem. A release build starts the packaged engine and fails unless
`stores.ftsAvailable === true` (2026-10-26).

Upstream result access (2026-10-17): attempt evidence/ResultReference services
are enabled from registered Harness driver support in the authorized configuration
revision, independent of AgentClass names. Custom Pi/Codex Executors receive
the same scoped read service. Pi installs evidence tools for bound attempts
even without web affordances; web tools still follow the AgentClass's affordances.
Direct-edge authorization and attempt-end revocation are unchanged. This source
fix requires an installed Desktop/Server update before retrying affected work.

Conversation tables and charts (2026-10-16): the shared Web/Desktop Markdown
renderer parses complete blocks before inserting authorized artifact links;
GFM tables remain semantic tables inside keyboard-scrollable containers.
Fenced `chart` JSON v1 is a bounded presentation contract (line/bar/area/pie,
200 labels, 8 series, 64,000 characters, at most 12 charts per body). Local,
lazy ECharts modules render validated values only; arbitrary options, scripts
and external resources are not accepted. Missing values remain gaps. Executor
guidance requests charts for useful numeric analysis with units and sources,
without inventing data or creating file outputs. Kernel/storage are unchanged.
Web offers SVG downloads; Desktop saves bounded PNG pixels through an owned-frame
native save dialog and atomic write, never arbitrary markup, paths or URLs.
Text-only clients retain the declarative data and accompanying prose.

Rich document preview (2026-10-15): Web/Desktop locally render HTML, DOCX,
PPTX, XLSX/XLS/CSV and PDF in the existing drawer. `documentFormat` is derived
presentation metadata; persisted `preview_kind` and historical files are not
rewritten. Management retains Account/Task/Conversation and path authorization.
Office parsing stays in a sandboxed browser reader, outside Planner/Kernel and
Executor input processing. The iframe has no same-origin or Desktop bridge
privileges; document networking/macros/scripts are not enabled. HTML can request
bounded PNG/JPEG siblings through the authorized report-image reader. Native
attachment saves accept Conversation/Attachment IDs only, never file paths or
arbitrary URLs. See the rich-document-preview plan for bounds and validation.

Recovered Task completion (2026-10-14): explicit resume recognizes a historical
official-login blocker and still rechecks current entitlement in Kernel.
Publication ordering uses current publication facts instead of superseded
dispatch order. Startup can seal a failed terminal write only from matching
durable failure and process-exit evidence, preserving the failed outcome and
completed Subtask results while releasing the exact leases. A retry that was
never armed is retired if its target is already terminal. Once cleanup is clear,
ordinary Kernel completion evaluation is re-triggered for all-done running Tasks.
See ADR-0023 and the [task blocking and status simplification plan](docs/plans/2026-10-15-task-execution-reliability-unified-plan.md)
for the remaining simplification work; the 2026-10-14 completed case remains historical evidence.

Blocked Task interaction (2026-10-14, amended by ADR-0049): Web derives ongoing
activity from the committed Task status (`running`), not cancellation eligibility. A blocked Task remains
unfinished but does not disable message submission. Task queries preserve the
active turn's cancellation controller and complete independently of background
work. Explicit resume uses the existing Gateway/Kernel path; ADR-0037 residue
checks and Conversation slot reacquisition remain authoritative. See the
blocked-task interaction implementation record for validation and local DMG.

Same-Conversation interaction evidence (2026-10-13, ADR-0038): SQLite schema 48
uses `(task_id, id)` as the execution-evidence primary key. An explicitly
selected historical interaction can be reused by new or existing Tasks in the
trusted current session, regardless of its source Task. Admission and execution
preparation share source/session/content checks. Preparing a recovered graph
revalidates and idempotently repairs missing task associations; it does not
resume blocked work. Existing evidence IDs remain stable, and conflicting
kind/source/exact-only identities cannot overwrite one another. Assistant
references remain exact-only. Preparation failures report their actual stage
before Executor launch; recovery remains Kernel-owned. The transactional 47→48
migration and source fix are validated locally and installed in the local
`0.1.14-internal-evidence-fix-20261013` Desktop/Server release. Real multi-turn
acceptance confirms cross-Task history reuse. File-delivery acceptance fails:
three Pi attempts made no tool calls or workspace changes yet reached done.
The 2026-10-15 reliability implementation addresses completion and delivery in
source; the existing user installation is not updated or revalidated by that
change. See the shared-interaction evidence repair plan for historical evidence.

Implemented locally (2026-10-06): ADR-0046 removes the ordinary Executor
research/engineering permission selector. The system-owned `standard-agent`
profile combines task file/command work and public HTTP(S); duties guide
allocation without granting authority. New installations seed this baseline.
Existing default Pi/Codex profiles (including aliases) migrate only through
unified settings activation. The historical engineering read-partition limit
of 8 is preserved by `standard-agent-read-8`; custom restrictions are not
expanded. Planner and pinned historical revisions retain their boundaries.
New baseline agents declare actual CLI affordances; existing routing owners
derive compatible delivery contracts from those facts and model evidence,
without requiring a generic research/engineering label. Native and Electron
acceptance passed; real Docker acceptance remains open because Docker is not
installed. See `docs/plans/2026-10-06-agent-baseline-permissions-design.md`.

Settings save/activation and legacy manual preview are deterministic and do not
call Planner or any LLM. ExecutorManualPreviewService preserves natural-language
duties, reuses only unchanged persisted assertions and never generates capability
grants. AI editing/explanation/public-model summarization remain explicit calls
to InternalLlmService. Planner hot rebinding only manages process/configuration
lifecycle; it must never become a settings semantic turn (ADR-0044 correction).
Generated Executor capability manuals retain their full content: the former
24,000-byte compilation and 60,000-byte Planner projection limits are removed
(2026-10-10, ADR-0015 correction). Valid Chinese/model evidence must not make
activation or subsequent `get_planning_context` fail solely due to manual length.
Settings has one activation action: “保存并激活”. Agent create/edit dialogs save
only to the current page draft, and confirmed enable/disable/removal also update
that draft. Read-only preparation uses the page's unactivated models/agents and
does not compile, probe, write a revision or require an idle account. The final
page action alone validates the combined candidate and enters the existing
strict-idle activation transaction; missing prices still block that activation.
Provider connections, Provider/Span Keys, model edits and the task concurrency
limit join this same draft. Management exposes no standalone credential-write
or configuration-rollback route; credentials are staged with compensation
inside activation. `runtimePolicy.maxConcurrentTasks` is hot-activatable, and
subsequent queue promotion reads the active limit rather than a startup copy.
Other attempt/backend policy limits remain restart-required.

Routing now compares natural-language duties and detailed model evidence through
the existing Mercury advisor (`span-fit-v5`). Generic coding/planning/long-context
labels and keyword overlap do not gate or score candidates. Concrete input,
protocol, delivery, permission and availability conditions still apply. The
advisor receives revision-pinned tool affordances and CNY token prices as well
as strengths, limitations and task descriptions. Unknown price is not free and
cannot satisfy an explicit cost ceiling. Deterministic fallback uses configured
numeric policies and stable ordering, not semantic guesses. See ADR-0033's
2026-10-05 amendment and the description-first routing implementation plan.

Settings responsibility rewriting uses the official SettingsAssistant business
operation independently of Planner. Model catalog descriptions are background data,
not duty text. Only a validated LLM-generated draft may replace the editor
text; unavailable credentials, failed requests and invalid/truncated output
preserve the source and report a controlled failure (ADR-0044). Deterministic
capability compilation remains separate from this semantic editing operation.
SettingsAssistant and selected-model OpenRouter profile summarization share
InternalLlmService, using fixed official business operations in production
(ADR-0047). Production does not load `internal/llm.json` or
`internal/llm-credentials.json`, and has no local-model fallback.
Summaries become model routingNotes; they never grant hard capabilities.
The Agent settings capability section uses a separate read-only internal-LLM
explanation of selected-model evidence and available tool affordances. It speaks
in terms of Agent tasks and boundaries, never pastes model catalog prose, and
does not replace user responsibilities or authoritative routing capabilities.

The source schema is now **47**. ADR-0043 has been implemented locally and
validated with the production browser and an isolated installed Server/TUI
release. User acceptance and deployment to the normal installation remain open;
see `docs/plans/2026-10-02-frontend-observation-implementation.md`. Schema 43 added the Workspace directory
projection/invalidation/rebuild tables and Conversation metadata/history and
Gateway segment-index read models. This supersedes the schema-42 baseline
description below; 42-to-43 is transactional and preserves existing facts.
The separate 43-to-44 transaction adds indexed Gateway command admissions.
Gateway retains admission policy and receipt ownership; Storage provides
account/key point operations and a recoverable-state index. The legacy account
JSON is imported once, including terminal idempotency receipts, atomically with
its account marker, then retained read-only. No parallel admission writer or
navigation-specific durability bypass is allowed.
Workspace owns the directory projection contract, Session/Application Shell
owns Conversation history/metadata ports, and Gateway owns its snapshot and
segment-index ports. Storage adapters never become lifecycle owners.
Ordinary directory reads must not replay Conversation journals or scan all
Tasks. Indexed history cursors retain insertion order across Turn replacement.
File-to-history updates use a durable write intent, replayed before serving a
record or page after interruption. Legacy JSON is retained for migration.
Source production composition now selects one `SegmentedEventJournal` writer
with bounded background compaction/orphan maintenance. `FileEventJournal` is
its read-only legacy import source, not a parallel writer. ADR-0043 Web/native
browsing negotiates `conversation_observation_v1`, `conversation_resources_v1`
and `multi_client_control_v1`: expired, future or over-budget projection cursors
receive a bounded baseline reset. Browsing never invokes audit replay. Old
`bounded_replay_v1` journal utilities remain for internal recovery/audit callers,
not the product clients' reconnect path. Unsupported clients receive an explicit
version mismatch. Legacy SQLite history parsing runs in one bounded worker per
account, using the same projector and transactional notification hooks; normal
navigation reads only the committed small entities. SQLite write transactions
reserve the writer with `BEGIN IMMEDIATE` before reading mutable facts, including
outer application transactions; this avoids WAL snapshot-upgrade failures while
the background worker commits. Read-only projection snapshots remain deferred.
Historical Task views use an exact Account/Conversation/Turn trace-observation
index, not the current-Turn snapshot or a full audit replay. Gateway folds safe
trace evidence; Storage commits its opaque projection with the segment index.
Two retained distinct Task IDs permanently preserve fail-closed ambiguity.
First/latest trace times and latest completion/progress fields remain
presentation evidence, never Task lifecycle authority. Legacy retained import
builds the same projection, which survives restart and segment compaction.
Visible history enrichment uses set reads for Task/timeline/artifact/billing
facts and preserves canonical billing authorization and projection semantics.
Native update checkpoints also protect the immutable journal bodies referenced
by the source database; rollback verifies/restores that companion before any
pointer switch (ADR-0030). A standalone SQLite backup is not a complete Gateway
checkpoint after segment compaction.
Schemas 43 and 44 have been canonically installed and tested on the real
account. Final rollout acceptance remains open in the navigation remediation
plan; earlier source-only checkpoints are historical. Web restoration reads off-page remembered Conversation metadata with an expected-Workspace guard; detail observation is independent of execution attachment.

Phase 6 established the durable attempt and recovery substrate, and ADR-0037
extends it to parallel top-level Tasks across Conversations. The active path
remains `event -> durable inbox -> Durable Task Coordinator -> immutable coordination fact -> durable dispatch items -> attempt supervisor -> normalized observation inbox`. The current `KernelWorkflow`/`ControlKernel` pair is the migration implementation of that coordinator; it serializes graph admission and durable application, while independent top-level Tasks from different Conversations may run concurrently within configured account limits. A Conversation has one durable execution slot; its later Tasks queue and never overlap its executing or cleaning-up Task. New attempts execute directly in the Conversation-bound Workspace: write attempts claim the authorized physical path before launch, while read-only attempts use a Runtime scratch directory and a read-only Workspace boundary. In-place attempts persist snapshots, change records, receipts and uncertainty through retry and recovery; they do not create a candidate publication. The Docker attempt backend remains an explicit compatibility mode. The isolated AnyFusion-Pi `PlanningAgent` owns user conversation, read-only queries and natural-language planning semantics; the Coordinator owns durable scheduling, cancellation and recovery facts, and Execution owns WorkUnit claims, leases, backend runtimes and Git side effects. Executor/Host owns capability decisions. See ADR-0037 and ADR-0053.

`src/planning/` owns the PlanningAgent interface (`AnyFusionPlanningAgent`), controlled-lifecycle AnyFusion-Pi JSONL RPC runner, the structured proposal contract, and catalog-aware validation. One Conversation maps to one persisted Pi session file. Semantic turns use `--mode rpc` over stdin/stdout JSONL and serialize writers per Conversation; MetaWork does not replay SQLite interaction history into prompts. Stable instructions and one fixed `metaclaw-planner/SKILL.md` live in the AnyFusion-Pi fork, while dynamic Task, runtime, authorization and routing facts come only from seven allowlisted read-only MetaWork MCP tools. Semantic RPC turns expose only those authoritative MCP tools plus the native proposal tool; Pi-native repository readers, Web reconnaissance, shell, edit and write tools are disabled in this mode. The interactive client-only TUI may retain read-only repository tools for workspace questions, but it does not own Web research or execution. New semantic Planner proposals may not use `direct_reply`: work-like requests must use `plan_work_graph` and a Kernel-authorized Executor, while historical direct-reply records remain readable for audit and replay. Slash-prefixed system commands stay on the Application-Shell path. Real-time/source-dependent facts, supplied URLs and public research requests are routed directly to an AgentClass covering `current-web-research`; the Executor performs final Web retrieval and receives the bounded current user input through `contextRefs`. Shell execution, unavailable Workspace inspection, file/Git/storage mutation, authenticated external actions, other side effects, durable progress, monitoring, artifacts and downstream handoffs require `plan_work_graph` and a Kernel-authorized Executor. This remains semantic Planner policy, not Session/Kernel keyword routing. MetaWork remains the only validator and the only owner of Task, Kernel, Executor and storage mutation. Pi submits `PlanningAgentPlan v9` only through its restricted native `submit_planning_proposal` tool. Runtime injects session, turn, user input and deterministic submission identity; the model supplies only `plan`. A rejection remains ordinary structured tool feedback in the same ReAct turn, with no proposal-specific retry count, repair prompt or outer coordination loop. `src/work-graph/` owns the shared v7 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Transport uncertainty is distinct from validation rejection and is resolved only by idempotently replaying the identical submission. Planner convergence exhaustion is a separate fail-closed terminal result; it creates no fallback proposal, Task, Kernel event or Executor attempt, and asks the user to retry or narrow the request. There is no assistant-text envelope parser, earlier-schema production parser, legacy intent route, semantic default, keyword fallback or Codex Planner fallback.`

The default local Client is the pinned `AnyFusion-Pi` fork vendored under `planner/AnyFusion-Pi` (checked into this repository, not a separate clone). Native macOS installation builds MetaClaw and Planner in separate dependency trees and runs them as isolated Node 22.19+ processes; the optional Linux container runtime preserves the same process boundary while sharing one image-level Node executable. `metawork server start` owns the persistent Runtime process and never launches a Client. Bare `metawork` is `metawork tui`: the interactive Pi process reads the Server endpoint manifest, starts with `--gateway-socket` plus an optional stable Conversation ID, submits versioned commands, renders ordered safe events, and never constructs or calls a local semantic runtime. `metawork web` only validates the same Server and opens its loopback origin together with a one-time, 60-second, non-authenticating startup directory hint; the Browser automatically establishes a local transport session, and the hint is applied only after that session through the ordinary authorized Workspace selection command. The local session is not a user identity or entitlement; the official subscription account remains the only user-facing login. The launch token never creates a session. A Client may also create a Workspace from the Web surface by browsing a local directory through the cookie-only read-only Server directory listing; path resolution, authorization and display decomposition remain Server-owned, and the browse endpoint grants no Workspace authority beyond the existing selection contract (ADR-0039). Client exit never stops Server work. Semantic Planning remains server-side. `src/tui-bridge/` exposes AnyFusion Planner Host Protocol v2 over a mode-`0600` Unix JSONL socket only for controlled RPC Planner proposal tools. MetaClaw injects an absolute Node command and compiled `planner-mcp.js` arguments; the Planner artifact carries no private Node runtime and never substitutes an uncontrolled executable. A missing fixed query tool fails before the first turn. A mid-turn MCP transport loss locks proposal submission and aborts that agent loop; the Conversation remains attachable and a later turn reconnects through the controlled process boundary. Pending permissions are recovered through bounded activity reads; clients submit request ID, request revision, generation and approve/deny using `permission_resolution_v2`. Permission arrival and resolution do not create a semantic Planner turn. `ConversationSession` reruns the v8 schema and semantic validation before emitting `plan_proposed` into `DurableKernelWorkflow`. The first accepted proposal locks the turn; rejected revisions remain open, identical submissions replay their persisted result, and a different post-acceptance submission conflicts. Neither Gateway clients nor the Planner Host bridge can directly access the database, Kernel, scheduler or Executor. Planner cannot synthesize privileged commands, edit, execute shell, mutate Task state, authorize work or publish Git changes. Executor attempts use trusted existing Codex/Pi CLI binaries with MetaWork-only attempt homes in the authorized Workspace or Runtime scratch directory, or canonical Codex/Pi attempt images in Docker compatibility mode. The only product terminal surface is the MetaWork TUI at `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/`, loaded lazily by the `--gateway-socket` branch: multi-Turn conversation projection, Pi editor/theme/components, Task Dashboard, read-only `complete_command`/`get_task_view` queries (ADR-0041), projection cursor/resource recovery, reconnect, versioned slash/permission/cancel commands, and no local semantic runtime. The former simplified client mode and the Ink implementation under `src/tui/` are deleted under ADR-0041. Client UI preferences (theme) live in the MetaWork config home, never in Planner home or the SecretStore.

The vendored CLI's `main.ts` is a mode dispatcher; only its non-Gateway branch
loads `main-runtime.ts`. The TUI uses the existing Workspace navigation commands,
connection-scoped query responses, and Server-provided Task/Attempt facts.
Older Task snapshots cannot overwrite newer applied Turn facts. Permission
actions require a fresh matching Task snapshot, and an admission receipt is
not a permission-resolution fact. History pages retain running Turns and
advance terminal status monotonically; local PgUp/PgDn scrolling never changes
Server state. See the September 20, 2026 TUI review-fix record.

Only the persistent Server acquires `runtime.lock` during ordinary operation;
native update/rollback takes the same lock while Server is stopped. Release and
exit cleanup are idempotent and verify the acquisition token, so an old Server
cannot unlink a successor's runtime/update lock. After account recovery and
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
Web presentation ownership is
`Conversation -> Turn -> one presentation Task -> Subtasks -> Attempts`.
A Turn binds monotonically to one presentation Task; Task-bound trace,
execution and artifact updates must match both `turnId` and `taskId`.
Trajectory defaults to the newest Turn, while an explicit historical Turn
selection reprojects only that Turn's Task. Existing mixed historical records
are filtered at read time without deleting durable Task, trace, artifact or
audit facts. Concurrent Subtasks within the selected Task remain visible.
Clarification is a completed turn that waits for a new user submission; it
does not retain active execution state. Turn status is monotonic once terminal,
so late Planner or presentation events may enrich the trace but cannot reopen
`completed`, `failed`, or `blocked` as `running`.
Work Graph owns the pure proposal-to-Runtime canonical Subtask identity map;
Runtime materialization and every Management replay/live projection use that
same map, without title, order or suffix guessing. Configuration owns
revision-pinned public routing identity resolution. Ordinary Web projections
show the Provider catalog label, configured model ID, Executor and Harness
display names, while internal model/provider refs, configuration revisions and
binding fingerprints remain server-side. If a historical revision cannot
recover a public model identity, the projection reports that the historical
model information is unavailable instead of exposing the internal ref.
Optional Span routing is the only external routing advisor. Reads normalize the
retired `respan/span-01-lite` advisor to `inception/mercury-decide:free`; startup
accepts the historical content hash only when reversing that exact substitution
reproduces it. Revision IDs, persisted hashes and immutable files stay unchanged,
and unrelated content changes still fail validation. Advanced settings
store its OpenRouter credential through the same SecretStore path as a Provider
key, but under the non-Provider `internal` namespace, and the revision keeps
only that fixed reference. Configuration validation accepts no other reference,
and the Server re-checks it before reading, so no revision can point the advisor
at a Provider credential; Provider references into the internal namespace are
also rejected. After the
shared hard filter and before the `plan_proposed` event is durably enqueued, the
Server may attach a bounded `spanRouting` observation to that event. At the SDK
boundary, structured state is sent as a JSON string for the OpenRouter System
One contract shared with Jev, with escaping included in the local 128 KiB
per-Subtask request budget (not a model token-context limit). The 32-candidate
limit remains; over-budget requests fall back without dropping candidates. Replay
reuses the persisted observation and never re-calls the advisor. `ControlKernel`
re-validates the observation and then uses its probabilities only to order
eligible candidates; it never widens the candidate set, and any absent, stale,
invalid, or failed observation leaves the deterministic resolver unchanged.
Preparation captures its cancellation signal, coalesces identical event IDs,
and rejects changed identities. Planning, scoring, admission and recovery use
the event's pinned configuration snapshot. System replan and merge replan use a
temporary validation-only Planner host through the existing Application Shell,
without requiring an attached client. Each Planner run captures its own model
and runtime environment; resolving a historical revision does not refresh the
shared supervisor or terminate another run. Explicit Turn cancellation returns no
replan and cancels its request. Session disposal or Server shutdown leaves an
interrupted replan application recoverable (`applying`), without admitting a
late response or treating shutdown as user cancellation. Span has two physical
request slots and at most 128 queued requests per Server; expired waiters are
removed and a transport ignoring abort retains its slot until it settles.

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
Runtime submits `task_resume_requested` with blocker category `retry`. The exact
`Stream ended without finish_reason` protocol failure also has a dedicated
`model_response_incomplete` code, retaining unknown-kind automatic recovery policy.
Explicit Resume may classify its current or older unknown receipt as `retry`;
material, contract, orphan and external-effect blockers remain authoritative.
Kernel rejects retry when recovery capabilities are externally non-idempotent;
blocked Subtasks must contribute to those safety facts even with an empty frontier.
Runtime does
not rewrite the receipt or coordination ledger, does not relax material,
contract or external-effect recovery, and the Durable Task Coordinator remains
the authority for `resume_task`. Task and Subtask state restoration is applied
only with its durable coordination command. Uncertain applications converge by declared postcondition rather than by
manual SQLite repair. One shared convergence entry runs at startup and on the
account periodic review, selected from durable pending facts rather than a
blocked-only Task scan. It inspects each managed action family (`dispatch`,
`replan`, `task_transition`, `plan_activation`, `resume_task`) and resolves the
application to `applied`, a safe retry inside a bounded budget, or explicit
`recovery_required`. Cancellation, external effects and the merge path keep their
dedicated reconcilers. An application that cannot converge — declared `unresolved`, or
`retry_safe` past its bounded budget — and a Replan Job that failed closed **for
the currently active graph revision** each emit a deterministic
`recovery_required_observed` Kernel event, and `ControlKernel` authorizes
`block_work` with a `recovery_required` blocker, so the Task cannot stay
`running`. Neither source requires an active graph revision: an initial
`authorize_task_plan` that failed before creating one still escalates. The pass
also drains whatever it re-queued, so a retried Decision is actually re-applied
and its next verdict observed. `/task recovery <taskId>` reports the same declared
postcondition family and verdict that recovery acts on. A legacy
`authorize_task_plan` application made uncertain solely by the former
system-binding `onDecisionApplying` presentation callback defect keeps its own
bounded Kernel-authorized retry path.

Timeout retry uses one Kernel-owned durable Retry Wake continuation fact rather
than a process-local timer. A `wait_for_retry` application transactionally
persists the `kernel_retry` Task blocker and the Wake (`armed`); the account
startup/periodic Worker conditionally advances it to `fired` and emits a
deterministic `timer_tick` only after that durable postcondition exists.
Timer identity is pinned to the Wake, source Decision and Attempt, generation,
configuration revision and binding fingerprint. Exact validation authorizes one
continuation dispatch, whose durable dispatch item, Task transition and Wake
consumption precede Attempt launch. Wakes converge to `consumed`,
`superseded` or `recovery_required`; a failed or contradictory Wake is never
presented as automatic `retrying`.

Task-control command acknowledgement is not execution authority. `/task resume`
reports authorization and pending dispatch after the first authoritative Kernel
Decision is `resume_task`; actual process start is an Execution trace fact.
`no_op`, `block_work`, and `park_for_replan` report that no new
Executor was launched and retain the Decision reason. The command result may
coexist with later Task/Executor trace, but `Command completed` alone never means
that a Task resumed or completed.
Gateway keeps the command explanation as its final result even when an old safe
partial result is re-delivered during the command. Partial output remains explicitly
uncertified and cannot certify completion or replace a denied-resume explanation.

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
safe projections; opening a Web Conversation does not open its execution session. Conversation
and Trajectory remain two views of the same trace and execution projection;
neither owns routing or execution.

ADR-0043 supersedes origin-only delivery. Same-Account Web, TUI and Feishu
clients may discover, observe, send, cancel and approve regardless of task origin.
Observation distributes safe, durable Conversation facts to explicit authorized
subscribers; command/query replies remain connection-specific. Ordinary browser
navigation reads metadata and a bounded projection, never activates a Planner
or replays the audit. Conversation content has one projection writer per client.
`cancel_turn` retains exact Turn targeting; `cancel_task` includes Task ID and
execution generation. `permission_resolution_v2` includes request revision and
generation, persists the first valid decision, and recovers accepted but unapplied
input through the Permission/KernelWorkflow seam. Admission is not application.
Feishu navigation is per authenticated principal; durable notification routes
capture chat/thread independently of navigation, and signed action references
bind the original principal and target. Delivery rechecks destination policy.
Schema 47 contains the body-separated Conversation read model, checkpoint/tail,
activity invalidation, staging rebuild, trace index, safe content search index,
client navigation, approval input and notification routing facts. Historical
search indexes content in bounded background ranges; indexed results are scoped
and matched only to the current Turn references. Baseline/detail reads are bounded
by bytes as well as rows. Revocation invalidates client state and pending reads.
The Web Conversation tab preserves its existing execution, report and billing
cards. Mounted messages automatically recover complete bodies; range transport
does not introduce manual full-text expansion or segment navigation. Transport,
Turn count and warm caches are bounded; a single full-body DOM is not size-capped.
The native TUI's right Dashboard lists Workspace Task summaries and navigates by
explicit Conversation/Task identity; the left pane retains the selected Turn's
execution and billing. F6 focuses the list; Enter observes and locates, never
activates execution. Summary counts describe loaded pages, with explicit paging.
See the implementation record for remaining acceptance gates; these source
contracts are not a claim that the user's installation has been upgraded.

## Account Runtime And Unified Gateway

ADR-0031 was implemented on 2026-08-19. Production startup constructs one
`RuntimeRegistry`, one `AccountRuntime` for `local-default`, one
`WorkspaceDirectory`, one `ConversationRegistry`, and one transport-neutral
`ClientGateway`. Production
client adapters do not construct `MetaclawSession`; that class remains only as
a compatibility/test shell; its UI-facing presentation code was deleted by ADR-0041.

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

ADR-0041 adds two versioned read-only queries to the same command plane for the
single-TUI convergence: `complete_command` (Workspace navigation scope or an
explicitly attached Conversation scope) and `get_task_view` (Account /
Conversation / Turn / Task association validated, structured errors on
mismatch). They run in a dedicated read-only admission branch: no semantic
mailbox, no Planner start, no Turn creation, no business work reservation, and
no persistent command-admission storage for drafts or candidates. Responses are
connection-scoped events (`command_completion`, `task_view_snapshot`) carrying
the explicit target Conversation ID, with sequences drawn from the same
per-connection allocator via ephemeral journal reservation. The Server hello
advertises the `command_completion_v1` and `task_view_v1` capabilities; clients
that require them fail closed with an upgrade prompt.
Desktop and Web share slash-command completion through this same read-only query;
common help, advanced discovery and candidates use the server's CommandCatalog.
Completion uses data only, including for unopened historical/new Conversations;
it never opens a Planner session. The current command reference is
`docs/current/commands.md`.

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

Feishu platform binding is machine-local. `gateway.platforms.feishu.enabled`
flips only through `metawork server bind-feishu` / `unbind-feishu` (or the
initial `setup-feishu` wizard), all of which activate through the authoritative
ConfigurationService so a running Server starts or stops its long-connection
bridge via `FeishuRuntimeManager`. Unbinding preserves the local app
credentials, never touches Feishu-side app state, and has no effect on other
machines sharing the same Feishu app. The Web surface offers no bind/unbind
operation.

`src/kernel/` currently contains the pure `ControlKernel` compatibility contract
and the durable workflow seam. Per ADR-0053, this code is being narrowed into
the Durable Task Coordinator: it may validate Work Graph identity, persist Task
facts, derive a runnable frontier and coordinate parallel claims/recovery. It is
not a security layer, does not choose Executor tools, and does not grant or
deny Executor capabilities. Capability requests are decided by the
Executor/Host policy path; the old Kernel permission actions exist only for
historical replay during migration. `ControlKernel` reads no time, IDs,
repositories, adapters or raw logs. Storage and Runtime implement the durable
facts and side effects outside the compatibility module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. A successful In-place primary/correction attempt commits an immutable receipt and change record, then completes the Subtask directly; it does not create a candidate publication. Workspace delivery records change facts and live references atomically after the attempt receipt is sealed. Every non-success commits a terminal receipt and returns control to Kernel policy. A first completion-contract failure may receive one response-only correction on the same AgentClass. In-place write uncertainty is fenced for reconciliation; legacy publication/merge-repair records are migration facts and are never dispatched for new work.

Local CLI attempts have no MetaWork-owned wall-clock, tool-count or processing-cycle
budget. `runtimePolicy.executorIdleTimeoutMs` is the sustained-inactivity check
threshold (default 5 minutes), never a kill deadline. Operations remain independently
observed while tools are active; real progress/checkpoints renew activity, duplicate
keepalives and Runtime presentation heartbeats do not. After 60 seconds the UI
shows no new activity; a health check has a 30-second response window. PID existence
alone yields unknown, not healthy/dead. Adapters report evidence; user cancellation
and existing Kernel decisions retain recovery authority. A busy sibling cannot
clear another operation’s unresolved health observation. A Kernel-authorized automatic retry is projected as
`waiting_retry`, keeps the originating turn non-terminal, and may update only that
Task's durable historical projection after a newer Conversation turn begins.

Executor path invariant: the Planner-projected `targetPaths` are Workspace-relative and the Kernel-derived `authorizedWorkingDirectory` is either the Conversation-bound Workspace root (or an authorized child) for writes, or a Runtime-owned scratch root for read-only work. Each Executor also needs a private runtime home for provider configuration, tools and sessions. These are separate path contracts. The adapter must materialize both before process launch and must never rely on a CLI's implicit `HOME` discovery. For Pi, the adapter must set `HOME`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` and pre-create the session directory. For Codex, the adapter must set an isolated `CODEX_HOME` containing the rewritten provider config. Startup should fail with a path-specific diagnostic if either the authorized directory or private runtime home is missing. Native and Docker compatibility launches seed that private home from the operator-managed templates (`METACLAW_EXECUTOR_CODEX_HOME`, `METACLAW_EXECUTOR_PI_HOME`) and inject provider credentials from the assigned env files (`METACLAW_CODEX_EXECUTOR_ENV_FILE`, `METACLAW_PI_EXECUTOR_ENV_FILE`); the host environment whitelist never forwards `OPENAI_*` on its own.

Turn cancellation invariant: the Client stop control cancels the Turn it is displaying, never by sending a Task command. The Application Shell latches the cancellation for that Turn, aborts the in-flight Planner process through `abortSession` (which keeps the Conversation session usable, unlike `stopSession`), rejects any Planner proposal that races the abort with `turn cancelled by user`, and cancels work that already became a Task through the existing Kernel cancellation fence. A cancelled Turn is `cancelled` (已取消), not `failed`, and a new Turn clears the latch. No Kernel event type is added, so cancellation stays a Client control over existing facts rather than a second strategic control plane (ADR-0040).

Managed path-naming invariant: durable identities (Task, generation, Subtask, attempt) stay complete in the database, the Kernel ledger and every handle/URI, while the on-disk directory names derived from them are deterministic bounded segments of at most 64 characters carrying a readable prefix/suffix plus an eight-character digest. This keeps a managed workspace at `<account>/workspace-store/workspaces/<segment>/<segment>/<segment>/files`, a managed Git repository and an attempt runtime HOME well inside `NAME_MAX` and inside the budget of tools that flatten a path into one component; a single long plan-event hash must never be repeated across nesting levels. The mapping is pure, so recovery recomputes the same directory without a lookup table. Executor failure facts are passed through the same way: `KernelFailure.summary` carries the upstream text as it happened, `detail` preserves the raw tail, `label` is only an optional localized headline, and `origin`, `stage`, `actor`, `provider` and `step` record where the failure came from. Client surfaces render that text instead of replacing it with a category.

The current product implementation uses SQLite schema version 61. Fresh databases start at v61; supported pre-release databases migrate transactionally through v31→v32→…→v59→v60→v61 on a verified clone while unsupported older schemas are refused. Schema 52 is the main-owned six-state Task base; schema 58 pins the single In-place Workspace binding and parks unfinished legacy Worktree publications instead of replaying an implicit copy. Schema v42 adds `generation_replan_requests.planner_claim_token`, the fencing token that makes one Planner turn land at most once even when two account workers re-claim the same Job after a lease expiry. Schema v41 adds the resolved routing identity columns (`agent_class_ref`, `provider_ref`, `model_id`) on `usage_observations`. Schema v39/v40 adds the ADR-0042 Query usage and billing facts: Query attribution contexts with one request-scoped idempotency key, Query-to-cost-Task links, execution-segment mappings, metering spans, normalized usage observations with one row per `(source_id, source_event_key, metric)`, normalization issues, immutable price versions, cost entries, per-Query bills and stage lines, the consumption outbox and receipts, bill adjustments, and the stable billing source-instance identity. Amounts are constrained decimal text; all aggregation happens in exact money code. Schema v38 adds the durable `planner_turn_inputs` record holding one Planner Turn's attachment facts for the host-bridge submission, so admission stays correct across a Server restart. Schema v37 permits image preview kinds in the durable `task_artifacts` table. Schema v61 adds the additive `kernel_dispatch_items.terminal_disposition` column (`executed` | `not_started`): `terminal` only means a dispatch item stopped being active, and success still requires a `completed` receipt. The migration converts active/recoverable Planning and Work Graph payloads from v7/v6 to v8/v7, including revision-pinned `executorBindings`, while terminal Kernel ledger history remains immutable. Any ambiguous recoverable payload rolls the cloned migration back and refuses activation; runtime has no earlier-schema read fallback. Schema v32 added immutable Result Objects and edge-scoped ResultReferences; schema v33 adds the Planner proposal configuration-revision pin used by replay and recovery. `awaiting_decision` and `awaiting_integration` remain Subtask-only states; startup recovery reconciles applications, child items, cancellation cleanup, execution-backend records, leases, publications and result delivery before accepting input. The physical names `attempt_sandboxes`, `sandbox_container_id` and `sandbox_lost` are retained only as durable schema/event compatibility names; new TypeScript abstractions use Execution Backend terminology.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The target active path is `PlanningAgent/Application Shell → Work Graph → Durable Task Coordinator → idempotent Runtime handlers → Executor/Harness`; the current `KernelWorkflow → ControlKernel` implementation is the migration adapter for that coordinator. Do not reintroduce a parallel strategic interpreter, a Kernel security gate, or allow a workflow framework to own Harness retry policy.

Startup inserts the missing `planner` class and force-converges the persisted `codex-cli` and `pi-agent` AgentClasses to their canonical definitions, including permission-profile bindings and the image fields used by Docker compatibility mode. Custom classes without a valid runtime command/permission profile remain audit-visible but fail closed. Only `planner-1` is seeded; executor WorkUnits are created and probed on demand after kernel authorization. `ExecutorRegistry` resolves every executable AgentClass through the backend-aware `BackendExecutorAdapter`; the in-place backend is the trusted native process path, and Docker remains explicit compatibility coverage rather than a second semantic executor router.

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

## Task Acceptance, Public Delivery And Managed Services (2026-10-21)

All clients consume the same TaskView pending decision. Accept/retry controls
carry exact Task, Generation, Graph Revision, Subtask, decision Attempt and Result
identities. The pending receipt and immutable safe result are resolved together;
a correction may reference its primary source only when both receipts agree on
the result ownership. Stale, cross-account or mismatched controls fail closed.
Acceptance revalidates files/security and enters ordinary publication without
rerunning the Executor. Explicit retry preserves history and cannot repeat an
uncertain external side effect. An independent runnable frontier keeps advancing
while another Subtask awaits a user decision.

Task creation persists an immutable Workspace-relative delivery root only when the
user explicitly selects an existing project subdirectory; otherwise delivery
uses the target Workspace root (ADR-0050). Recovery/retry cannot change it. Runtime records the baseline and
checks user edits, full code deltas including deletions, symlinks and path escape
before publication. Non-Git writes use staging and rollback; Git delivery uses a
controlled branch and checked fast-forward into the actual user tree. A delivery
is successful only after the public files exist. Published code facts are
separate from Planner-declared downloadable fileOutputs. Ordinary clients expose
only the Workspace, public task directory, relative files, delivery state and
conflicts; internal execution paths and secrets are redacted from public text.

Planner proposes service intent; the Durable Task Coordinator validates the
Task/workspace identity; Runtime owns the process.
For an explicit implement-and-start request, startServiceAfterPublish gates
completion on publication and a real health check. The Executor produces
.metawork-service.json without needing a Task ID; Runtime binds that identity and
rejects an explicitly foreign one. The manifest declares command/args, relative
directory, environment references, loopback host/port, health path, startup
window and explicit restart policy. Runtime starts from the verified public
project, persists ownership and durable operation phases, observes across Server
restart, and serializes process-group start/stop/restart. A failed health check
remains needs_action. Stop retains delivered code and remains available when
productive authorization closes. Existing Tasks accept bounded service controls
without rerunning the graph. Service logs contain neither secret values nor
private Runtime paths. Schema 58 stores the single In-place Workspace binding, target paths, change records, public delivery baseline, service records and operation journal; 57→58 migration is transactional and parks unfinished legacy Worktree publication rows.

### Service identity, current specification and diagnostics (2026-10-27)

ADR-0051 fixes the service model that the Agent execution architecture
realignment depends on:

- Service identity is `(accountId, workspaceId, serviceId)`. The owning `taskId`
  stored on the record is provenance, not identity, and it moves to the current
  Task when that Task re-launches the same launch contract.
- `specificationRevision` hashes the launch contract only (service id, command,
  args, directory, environment references, loopback host/port, health path,
  startup window, explicit restart policy). It does not hash `taskId`, so an
  unchanged service re-requested by a later Task keeps the same revision.
- The current Task specification decides what happens next. A historical
  `failed`/`stopped` record is diagnosis input: it never blocks the current
  round's start. A record whose revision differs still requires an explicit
  Kernel service update authorization; a record from another Workspace is a
  different service.
- A manifest left in an In-place Workspace by an earlier Task is accepted only
  when this Workspace already registered the identical launch contract for that
  service id. Otherwise the manifest still belongs to its author and is
  rejected.
- `ManagedLocalServices.observe()` returns Runtime-only diagnostics
  (workspace, revision, process identity, exit fact, bounded redacted log tail,
  last health status, agent-repairable flag). They are never part of the public
  `LocalServiceView`, which continues to expose only state, URL and message.
- A service that does not reach health is **not** a Task conclusion. The Runtime
  records a `repair_pending` service operation with the real diagnosis (exit
  fact, health status, redacted log tail, revision) and reopens the producing
  Subtask (`completed → awaiting_completion`, the only outgoing transition a
  completed node has) so the Kernel can authorize one bounded repair
  continuation for the same Executor category: `dispatch_requested` with
  `attemptKind: 'continuation'` and a `metawork:service-repair:v1` payload. The
  Kernel owns the budget (three rounds), the ordering (`repairOrdinal` must equal
  the durable round count) and the binding identity; the Runtime re-verifies the
  service after each round and re-reads a repaired launch contract through the
  explicit Kernel `update` authorization. When the budget is spent, the Task
  reports the true error and the attempted rounds. A Task therefore never reaches
  a terminal state while an authorized repair round remains.

### Follow-up execution, optional service specifications and execution facts (2026-10-28)

The 2026-10-28 transparent-execution specification completes ADR-0051 and keeps
ADR-0053's ownership split. A follow-up operation keeps two separate identities:

```text
sourceTaskId  = the finished Task whose artifacts are referenced (history)
executionId   = this operation's own decision/attempt/operation identity
```

The source Task's status therefore never decides whether the artifact may be
used. Starting, previewing, verifying, restarting or modifying a delivered
project does not change the historical Task conclusion and does not require it
to become `running` again. The Kernel relays the operation and keeps only
mechanical checks (Workspace ownership, registration identity, revision,
publication presence); it does not refuse because a Task already finished and it
does not classify one-off runs vs long-lived services.

Target project resolution is a durable-fact decision, not a guess:

- The Task's delivered artifact paths identify the target project directory; an
  entry file (`package.json`, `server.js`, `main.py`, ...) or a project-local
  manifest makes that directory a candidate.
- A Workspace-root `.metawork-service.json` is a candidate only when the Task
  delivered no runnable project of its own. An old service file at the root can
  never override the run target of a newly delivered project.
- More than one candidate is a real ambiguity: the Runtime refuses with the
  candidate list instead of choosing, and the Planner asks the user.

`.metawork-service.json` was never a prerequisite for ordinary work: only the
managed-service path (an explicit implement-and-start request, or an explicit
`service_start`/`update`) required it. That path is now optional too. Contract
precedence inside the resolved target is: the target project's manifest, then the
recorded contract of that same project in this Workspace, then a launch
discovered from the project (`package.json` scripts/main, entry files).
Discovery records its evidence. A launch contract carries
`origin: 'manifest' | 'discovered'` in its revision, so adopting a manifest after
a discovered start is an explicit `update` decision.

A discovered contract declares no port and no health path: the Runtime allocates
a loopback port, passes `HOST`/`PORT` only when the contract declares a port, and
records the process as `running` (process alive). `running` is not `healthy`:
nothing verified an HTTP endpoint, and task completion treats it as ready only
because that is the strongest fact the contract declares. A port-owning
operation (health check, URL) exists only when the contract declares one.

An Attempt owns its process group, not only the process it spawned. The Executor
CLI is spawned as a group leader, so every command, browser, watcher or helper it
starts stays in that group even after the leader exits. Settlement therefore reaps
the group on every path — cancellation and normal completion — with SIGTERM, a
bounded grace and SIGKILL, and records the bounded residual facts
(`pid` + executable basename) on the Attempt. Only members younger than the
Attempt are signalled, so a reused process-group id can never touch an unrelated
process. A long-lived process must go through the managed-service path (Runtime
records its token, state and URL); an Executor must not daemonize. A successful
Attempt that had to be cleaned up is reported as such instead of a silent success.
The Workspace source of a correction or accepted-result commit is the authorized
Workspace binding — never the account-wide legacy `sourceRoot`, which points at
the internal workspace store and is refused explicitly.

Dispatch facts are equally explicit. A `kernel_dispatch_items` row that is no
longer active is `terminal`, and `terminal` means only "this dispatch item no
longer owns scheduler capacity". `terminal_disposition` records how it stopped:

- `executed`: the Runtime reported an execution fact for the Attempt.
- `not_started`: the Attempt yielded before executing (resource-partition
  conflict, unavailable Executor). No receipt, Attempt runtime, work unit or
  measured duration exists.

Success is proven only by an immutable receipt with `terminal_state = completed`.
Projections never label a dispatch item "已完成" from its status alone, and a
`ready` Subtask keeps its canonical state even when its last Attempt yielded.

User-facing status has exactly one vocabulary. Only the six Task states
(`排队/执行中/待处理/成功/失败/取消`, ADR-0049) are presented as task status, and
every surface reads them from the same durable TaskView/ExecutionTimeline fact.
Dispatch status, `terminal_disposition`, Attempt/runtime facts, receipt terminal
states, Subtask lifecycle, work-graph node state and trace/stage state are
internal: they may choose progress text and visual encoding, but they are never
rendered as a status label or chip. An execution card therefore shows progress,
not its own status; a planner-only Turn names its phase, never a Task conclusion.
Progress text must also be true at read time: a terminal fact is not narrated as
"正在校验…", a yielded Attempt does not claim the Executor started, and a missing
timestamp shows no duration.

Timing obeys the same rule: end-to-end Turn time, queue time and measured
execution time are separate facts read from the same entity. Execution duration
uses the Attempt runtime start and the receipt completion only; when either is
missing the surface reports no duration (or `尚未执行`), and a real sub-second
execution is `<1s`, never `0s`. A Planner-only Turn is labelled "已完成规划，未启动
执行" and never as a completed Task.

`retry_remaining_work` is an internal recovery protocol, not a user command: after the
service repair budget is spent, the Kernel refuses a repair round, or file delivery
fails, the Runtime re-does only the remaining delivery/service work in a successor
Task when the completed work is safe to reuse. It runs at most once per failure line
(a remaining-work retry never spawns another one) and reuses an existing successor.
A refused retry keeps the real failure conclusion.

Completion evidence belongs to the result, not to the newest attempt. An
accepted or certified receipt of the current generation proves the node even when
a later completion-metadata correction failed; a failed correction repairs
nothing and therefore hides nothing. A `needs_action` Task whose reason is
system-caused (`no_authorized_driver`/`system_anomaly`) and whose durable facts
now prove every required item complete with no pending action is corrected to
`succeeded` — the only extra edge in the transition table, guarded by the
authority (system reason only) and the lifecycle port (no pending actions). A
block that asks the user to accept, retry or provide input is never overridden;
recovery re-evaluates such system blocks once per pass so they converge without
user work.

A Terminal Task (succeeded/failed/cancelled) is a historical fact, never an
admission blocker: the Conversation slot is released before the next planning
turn, the current explicit request supersedes it, and the old Task keeps its
conclusion and history. A follow-up round starts from the real diagnosis rather
than a guess: the Planner's authoritative `get_task_context` fact carries the
Task conclusion reason, the bounded non-success operation results and the last
failed Attempt code/summary, and the Executor context carries a bounded
`previousRound` projection of the most recent failed Task in the same
Conversation and Workspace. Ordinary In-place completion needs no user
acceptance: workspace file state reports file facts only, `accept_result`
belongs to uncertified or partial results, and `/task retry` is an explicit
secondary recovery rather than the ordinary next step.

Every authorized Subtask now also receives one **Run Contract projection**
(`src/execution/run-contract.ts`): the Workspace, objective, acceptance, access
mode, `fileOutputs`, service intent, configuration revision and binding
fingerprint the Attempt was authorized for. It is a bounded input/diagnostics
projection recorded on the Attempt, not a new scheduling authority: Harness
turn/tool/repair loops stay inside the Harness, and Kernel authorization stays
at dispatch, resource and verification boundaries.

## 单一 In-place Workspace 执行模型（2026-10-25，ADR-0050）

MetaWork 新任务只有一种 Workspace 写入语义：Executor 直接在 Conversation 绑定的
Workspace 中执行。Planner 的 `workspaceIntent` 只声明读写操作、Workspace-relative
目标路径、原文件策略、置信度和理由；Kernel 将它确定性地解析为 `read` 或 `write`
admission。写入 Attempt 在启动 Executor 前申请物理路径 write lease，冲突任务进入
`resource_waits`，租约释放后重新校验 binding 再执行。

普通编辑、新建文件、继续编辑和目标 Workspace 命令都写入同一目录。系统不为新任务
创建 Git worktree、复制 Workspace、候选目录或二次 publication。成功的 In-place
Attempt 直接完成 Subtask，并保留 before/after snapshot、变更清单、receipt 和
uncertainty 事实。

Before/after 观测优先使用 Git status/tree 通道。普通非 Git Workspace，或 Git 观测失败时，
Runtime 回退到 Kernel 已授权 `targetPaths` 的有界文件系统快照；变更记录明确标记为
`partial`，并记录 `filesystem_scope_limited`。这足以认证授权范围内的代码编辑，避免把真实
改动误判为空 delta；快照截断或不可读时仍保持 uncertified。完成认证以 Runtime 观测到的
delta 为准：只有确实没有变化的 edit 才要求 `noChangeReason`，模型遗留的过期说明不会再
触发无意义的用户验收。

`read_only` 是访问事实，不是第二种执行模式。只读 Attempt 通过受控只读边界读取
Conversation Workspace，临时文件进入 Runtime scratch，不申请 Workspace write lease，
也不创建 publication；声明 `fileOutputs` 的报告按写入 admission 处理。旧 Worktree
binding 和未完成 publication 只停放用于审计，恢复时明确拒绝，不能静默切换目录。

## Current Server Upgrade Baseline

The current implementation uses PlanningAgentPlan v9, Work Graph v7, Kernel wire
v5 and SQLite schema v60. ADR-0027 through ADR-0030 govern the configuration
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

ADR-0033's 2026-09-19 amendment tightens Web/Management activation admission
to the strict idle rule (CLI administration is explicitly deferred):
any continuable Task (`created`/`ready`/`running`/`parked`/`blocked`), Planner
turn, accepted-but-unprocessed work request, execution, publication,
cancellation cleanup, or recovery marks the whole account busy, and unknown
activity fails closed. New-work admission and configuration transactions share
one account-scoped interlock so neither can overlap the other, and a work
reservation covers the full span from authenticated admission to Planner
completion or Task persistence. While strictly idle, Executor AgentClasses
backed by existing `pi-cli`/`codex-cli` Harnesses may be created, edited
(display name, model policy, existing permission-profile reference, manual
text, enablement), enabled, disabled, and removed with hot activation; tool
changes, Planner lifecycle, Harness/driver/command, and permission grammar
stay outside this surface (ADR-0028 §6). Tool compatibility derives from the
resolved Harness driver, never from names. Provider/Model and credential changes through the Server join the single
full-configuration activation transaction and use the same gate. Compensation
remains inside that transaction; standalone settings rollback is not exposed.
Shared Key reads never import credentials; manual compilation runs inside the
activation transaction. AgentClass queries read current configuration rather
than a startup copy. Execution resolves permission aliases to code-owned
profile IDs in the exact authorized revision, never by name or active fallback.
Failed compensation blocks further work and configuration
changes pending restart/recovery. Required installation facts follow enabled
tools; zero enabled Executors rejects new work but not settings/history.
The legacy CLI administration path is unchanged by owner request and must not
be used to mutate configuration alongside a running Server.

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

The ordinary Web settings vocabulary is intentionally simpler than the
architecture vocabulary: Provider entries are shown as models, and
Executor/AgentClass entries are shown as agents. Optional revision-scoped
`displayName` values are presentation labels only; stable Provider,
AgentClass, Harness, routing, capability, and historical binding identities do
not change when a user renames an item. The default built-in agent labels are
`智能体 1` for `pi-agent` and `智能体 2` for `codex-cli`.

Production Provider credentials are stored in the single MetaWork-root file
`<metawork-root>/credentials.json`, which defaults to
`~/.metawork/credentials.json`. The existing `SecretStore` runtime seam
resolves Provider references through that file; Web returns only configured
state and a masked Key, and an update replaces the stored value. This feature
does not add a `~/.config/metawork` persistence root.
Local Agent credential discovery only initializes missing credentials for an
unambiguous Provider that the active revision already configures; it never
overwrites a saved MetaWork Key and never preheats credentials for a Provider the
user does not have. Matching a Base URL alone cannot authorize credential reuse.
Settings deduplication requires both normalized Base URL and complete Key
identity; unknown credentials cannot be merged (2026-10-05 correction).

Provider membership is the active configuration's alone. The settings page
renders one card per activated `providers` entry; the completion service, the
public preset catalog and local Agent discovery may describe such a card but
never create one. Installer and settings Providers are the same resource with
the same edit and delete rules, there is no undeletable or special Planner
connection, and `openai-compatible` versus `openai-responses` is part of the
Provider identity rather than something one can be overwritten with. Deleting a
Provider takes effect only through activation, and the activation that commits
the deletion also removes the Provider credential when no remaining Provider or
internal reference uses it (2026-10-26).

Application-Shell agent readiness is separate from Kernel Executor health.
Pi is required for new-work admission, while login, Workspace access, history,
settings and readiness refresh remain available when Pi is missing. Codex is
optional and its absence never blocks work; the Web projection explains its
additional GPT/Codex compatibility and coding benefits without suggesting that
Pi lacks coding capability. A readiness transition never cancels an already
admitted Task.

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
The signed release matrix includes macOS Intel/Apple Silicon, Windows x64, and
Linux x64/arm64 host builds. Windows native clients use deterministic named
pipes and `.cmd` launchers; macOS/Linux retain filesystem Unix sockets and
`install.sh`, while Windows uses `install.ps1`. Linux native dependencies are
never fabricated on macOS through a cross-platform archive-only build.
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

Executor runtime homes use semantic verification for the exact authorized
Provider/Model and managed execution settings. Pi JSON and Codex TOML are
parsed before launch; formatting, object-key/table order and unrelated catalog
entries are ignored, while missing or malformed files, duplicate or missing
selected Models, and changes to the selected service address, protocol,
credential reference, model capability or execution setting fail closed. The
expected scoped facts come from the immutable revision manifest and contain no
credential values. This launch check is separate from the authorized binding
fingerprint and the configuration revision/artifact/publication hashes, which
retain their existing identity and integrity roles.

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

## Query Usage And Billing (Target)

ADR-0042 accepts Query-scoped usage metering, exact billing and idempotent
external consumption submission as a target contract. This section records the
runtime invariants that apply once the governing implementation plan's release
gate passes; it is not a description of a delivered capability.

- **Accrual root.** A Query is one semantic request accepted by the Server, or
  one explicit user action that starts a new execution segment. A Query is not
  a Task and not a Turn. A Query may have no Task and still accrue cost. A
  Query is linked to at most one cost-bearing Task, and only through a
  Kernel-authorized application fact; Task totals sum assigned finalized Query
  amounts and never re-price or re-charge.
- **Persistence before charge.** Query identity, pinned price/payer/policy
  versions, execution-segment mapping and any chargeable span are persisted
  before the first chargeable call. Transport retries of the same request key
  reuse the Query; a different payload under the same key is rejected.
- **Orthogonal metering.** `stage`, `reason` and `resource` are never summed
  into each other; exactly one authoritative coverage level is summed per
  covered range. Missing usage is `unavailable`, never `0`. Payer
  (`platform`/`user_direct`/`system`/`unknown`) is derived from trusted Server
  configuration, not from model names or client claims.
- **Exact money.** `1 MetaCoin = 1_000_000 microCoin`, `1 CNY = 1_000_000_000
  nanoCny`. Exact rationals until a single half-even rounding at the Query
  total; cross-process amounts are decimal strings; stage detail is a
  largest-remainder distribution of the finalized total.
- **Final bill is immutable.** `collecting -> pending_reconciliation ->
  finalized` locally, with `not_exported -> pending -> received -> confirmed`,
  plus `unknown`/`rejected`, for the external leg. `received` is not
  `confirmed`; `confirmed` requires an external entry id and an exactly matching
  amount. Late cost is a separate `bill_adjustments` fact, never a silent top-up.
- **No local funds.** MetaWork stores no balance, does no top-up, payment,
  refund, fund freeze or budget reservation, and never gates admission on
  balance. The independent third-party system owns funded accounts and actual
  deduction.
- **Clients project.** Web, TUI and Feishu read bills, Task usage summaries and
  account usage summaries through Gateway read-only queries under the optional
  `usage_billing_v1` capability; they never compute authoritative prices and
  never send a consumption charge.
- **Export gate.** `observe -> shadow -> export` is the only release order.
  `export` requires a trusted deployment boundary, a stable
  `sourceInstanceId + billId` idempotency key with a payload digest, third-party
  state query, sufficient amount precision, pinned price versions, and verified
  restart/duplicate-delivery behaviour. Otherwise the deployment stays local or
  shadowed.
- **Reliability scope.** Residue fences, durable account wakeups, queue-limit
  enforcement and scheduling fairness are fixed inside the existing Kernel
  authorization path. Metering and billing never gain scheduling authority, and
  no shared multi-tenant Runtime, user registration, organization permission or
  cluster scheduler is introduced.

New domain vocabulary:

**Query**:
One Server-accepted semantic request or explicit new-execution-segment user
action, recorded as the durable accrual root before its first chargeable call.
It may exist without a Task.
_Avoid_: Turn, message, Task, attempt, conversation

**Metering Span**:
The durable scope over which one chargeable call's usage is attributed, with
started/closed/uncertain lifecycle and exactly one authoritative coverage
level.
_Avoid_: Task, Turn, bill

**Usage Observation**:
One immutable normalized measurement from a single source event, carrying its
source scope, stage/reason/resource, unit, raw counters, quality and evidence.
_Avoid_: cost, bill line, price

**MetaCoin**:
The accrual unit MetaWork assesses for a Query (`1 CNY = 1 MetaCoin`, stored as
integer microCoin). It is not a stored balance and MetaWork never deducts it.
_Avoid_: wallet, balance, credit, payment

**Payer**:
The trusted classification of who bears a cost — `platform`, `user_direct`,
`system` or `unknown` — derived from Server configuration or verifiable
credential relationships.
_Avoid_: provider name, model name, client-declared owner

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
occupied while cancellation, publication, container, WorkUnit, lease, uncertain
Kernel application or outstanding Replan Job residue remains; a Task that is
blocked with no such residue releases its slot and promotes the next
same-Conversation Task exactly once.
_Avoid_: request, prompt, executor run, browser tab

**Subtask**:
A decomposed piece of work inside a Task, planned so it can have at most one pending/active attempt at a time. Its lifecycle is `ready | running | awaiting_integration | awaiting_decision | blocked | done | cancelled`.
_Avoid_: work unit, executor instance, raw prompt

**Task State**:
The persisted Task conclusion, owned by the Task Domain in `src/task/task-state.ts` (ADR-0049): `queued | running | needs_action | succeeded | failed | cancelled`. There is no second mapping: no raw-status table, no `userState`, no `coordinating`/`waiting_for_user` duplicate vocabulary. `state_version`, `state_detail_json` (reason, phase, pending actions, required work, cleanup, next wake), `completed_at`, `archived_at` and `retry_of_task_id` travel with it. Archiving is an attribute, never a status; a retry is a related Task that keeps the original conclusion.
_Avoid_: executor state, work unit state, raw status as user-facing prose

**Task View**:
The one read-only projection of a Task for TUI, Web, Feishu and command output (`src/task/task-view.ts`). Its contract is the committed `TaskStateSnapshot` (`status`, `stateVersion`, `reason`, `phase`, `pendingActions`, `cleanup`, `nextWakeAt`) plus operational detail: the active Attempt, Subtask node states, current Replan Job, recovery fact, blocking residue, result and timestamps. It never derives a status from logs, dispatch rows or a raw column.
_Avoid_: per-surface status mapping, dashboard-owned reconciliation

**Task State Authority** (`src/task/task-state-authority.ts`): reads durable facts, calls the pure `evaluateTaskState()` and applies one state change. Runtime handlers report operation facts and ask it to reconcile; they never pick a status. No synthetic transition paths are allowed. Acceptance/retry records, the Kernel application, continuation outbox and queue entry commit atomically; publication waits for a fresh reservation and validates its token/version. Definite delivery/service failure keeps the original Task terminal; `/task retry` creates a linked Task for reusable unfinished delivery/service work. The state projection outbox feeds the existing durable activity queue. Web/TUI require Task View v2 and reject lower Task versions.

**Task Lifecycle Transition Port**:
The single durable writer of Task state (`src/task/task-lifecycle-transition-port.ts`) and the owner of Subtask node transitions; both assigned to the Task Domain by ADR-0020, with Work Graph owning proposal topology, node identity and the runnable frontier. `applyTaskChange()` resolves the operation key (idempotent replay), validates the Decision identity, expected `state_version`, active graph and cancellation fence, applies narrowly scoped local facts, writes the state and the `task_state_changes` audit row, and appends a durable projection notification in one transaction. External process/Git effects are never inside it.
_Avoid_: per-module status writes, TaskView-owned repair, one residue rule per caller

**Task Residue**:
The one answer to "can this Task's Conversation slot be released", produced by `TaskResidueReader.blockingReasons()`. Completion, cancellation, startup recovery, periodic recovery and TaskView all read it; a caller that must discount its own in-flight Decision passes that Decision id explicitly. A Task that is blocked with no residue releases its slot; a Task with `pending`/`applying`/`uncertain` applications, a terminal dispatch item without a receipt, an outstanding Replan Job or a live lease keeps it.
_Avoid_: local residue re-derivation, optimistic release

**Kernel Application Settlement**:
How an authorized Decision that produced no observation reaches a durable end state. A Runtime apply may prove its outcome without an effect: `rejected_without_effect` (a refusal that wrote and started nothing — unpublished service manifest, Kernel `reject_request`, service Task outside the Conversation) or `operation_settled` (a journaled operation that completed with a recorded error). Both are written by `markApplicationSettled` as `applied` with a tagged summary (`kernel_settlement/<kind>:<code> <detail>`, `src/kernel/kernel-application-settlement.ts`), and the postcondition sweep reads that tag. A refusal or outcome that cannot be proved stays `uncertain` and becomes `recovery_required`, so it still reaches the user. The Kernel reason and the Conversation output name the `serviceId`, the owner Task and the owner Task status.
_Avoid_: throwing a deterministic refusal into the parent application, matching free-text error summaries to settle historical rows

**Attempt Settlement**:
An Attempt is `authorized -> launched -> running -> settling -> settled`. Settlement is proven by the immutable `executor_attempt_receipts` row plus the closed dispatch item, and carries a separate immutable outcome (`succeeded | failed | heartbeat_lost | cancelled | unknown`). "Attempt settled" replaces the public phrase "dispatch terminal"; a settled Attempt alone never completes a Task.
_Avoid_: attempt as Task status, dispatch status as outcome

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
A strict v8 proposal from the PlanningAgent describing intent, target, task control, risk, confidence and clarification needs. It contains one non-empty v7 work graph only for `plan_work_graph`, or an exact approve/deny resolution only for a pending `authorization_resolution`; all other action-specific fields are null. The graph pins one `configurationRevision`; each node uses structured dependencies, typed context references, keyed acceptance criteria, `deliveryKind: edit | report`, and one or more complete Executor binding candidates. A plan is executable after Work Graph validation and durable Task Coordinator admission; Planner fields never become a Harness tool allowlist.
_Avoid_: runtime command, task event, execution policy

**ControlKernel**:
The migration compatibility module for deterministic Work Graph admission,
frontier coordination and durable recovery facts. It is not a security layer,
does not select Harness tools, and does not own Executor capability policy.
The target public seam is the Durable Task Coordinator; `decide(event,
snapshot)` remains only while the extraction is in progress.
_Avoid_: planning agent, runtime applier, executor router

**KernelDecision**:
A migration-era durable coordination command applied by Runtime. It is not a
permission grant and cannot widen an Executor's tools or Host boundary.
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
The sole execution-structure fact for one task generation: a v7 revisioned DAG pinned to one configuration revision, with capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every node declares its primary delivery channel (`edit` for Workspace/file delivery, `report` for report/answer delivery); both kinds may create ordinary user-space files, including Workspace files and research intermediates. It carries ordered complete Executor bindings rather than free-form class preferences. Every edge has one to twelve keyed `text` or `artifact` items; only published direct-edge handoffs and controlled task evidence enter downstream context. A pure function derives the runnable frontier without persisting an execution layer. The Durable Task Coordinator may claim up to four independent nodes in one deterministic batch; Harness retry/repair remains inside the Executor, while cross-attempt recovery and publication remain durable coordination facts.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing requirements, Planner-selected evidence, Planner-selected historical Artifact inputs, Planner-selected current-Turn Attachment inputs, sibling titles marked out of scope, workspace boundaries, the completion-report contract, and evidence-tool availability. Historical `artifact` and current-Turn `attachment` ContextRefs are selected by Planner semantics, validated by MetaWork against Account/Conversation/Workspace/status/source/hash facts, and materialized into the attempt-local input directory before execution. Runtime retains Task/Subtask/attempt/WorkUnit identities and all acceptance/handoff keys outside model output. MetaWork core never parses attachment contents. The native release prepares the reviewed system-Pi PDF extension and its isolated dependencies; that extension owns document parsing. Document parsing is owned by the routed Executor's own base model and tools; upload success is not a claim that every Executor supports every format. The eligible attachment set is a Turn fact, not a call-site fact: it is recorded once when the Turn starts (durably in `planner_turn_inputs`) and read by both the in-process and host-bridge submission paths, and a replan inherits the attachments of its Task's originating admission event instead of inventing new ones.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Planner Context Bridge**:
A bounded, read-only MetaWork projection exposed through the existing Planner MCP
queries. It supplies current Conversation facts about interactions, Tasks,
Executor results and published Artifacts; it does not perform semantic search,
resolve natural-language references or choose a ContextRef. Pi session history
owns semantic continuity, Planner selects stable references, MetaWork validates
identity/availability/hash, and Runtime materializes only selected inputs.
Executor prompts expose a working-directory-relative `readPath` for each
materialized input, alongside its input-directory-relative name. Missing
selected inputs must be reported instead of searching the disk, user home,
or other Task directories for replacements.
_Avoid_: semantic router, vector search, transcript replay, Executor database access

**Completion Protocol**:
The active Executor response contract is Completion Protocol v4. A non-empty
Markdown body may be followed by strict identity-free completion metadata, but
body delivery and completion certification are independent axes. Missing or
malformed marker/trailer, evidence cardinality/length, ordinary duration and
physical transport limits may leave a safe body `partial` and `uncertified`;
they must not discard it. Runtime computes one authoritative workspace delta
before certification, retains internal identities outside model output, and
derives artifacts from existing declared files (`fileOutputs`; historical
authorizations without the field retain their former delta-based delivery). Ordinary Workspace and user-space
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
The attempt-bound, Task-scoped read-only port for eligible user input, user materials, and materialized long-term memory evidence. Ordinary assistant/Executor output and dependency results are not generally searchable; an explicitly authorized assistant interaction is exact-get only.
_Avoid_: conversation transcript, cross-task search, dependency output channel

**Attempt Receipt**:
The immutable terminal audit for one Task/Subtask/attempt/WorkUnit/AgentClass invocation, including attempt kind, provenance, raw response and parsing/verification facts. A successful receipt proves candidate production, not publication or Subtask completion.
_Avoid_: retry state machine, user-visible result, mutable handoff

**Cancellation Fence**:
The durable Kernel-authorized transaction that makes a Task or an atomic downstream Subtask closure non-runnable before Runtime starts physical cleanup. Active dispatch/publication rows remain `cancelling` and continue to occupy capacity until the selected execution backend has exited or is confirmed missing and WorkUnit/resource leases are released. Outcomes arriving after the fence are stale `no_op` facts.
_Avoid_: best-effort process abort, status-only update, rollback of published facts

**Generation Replan Request**:
The one durable ordinary automatic-replan request for a Task generation/revision. Multiple exhausted Subtasks coalesce into it; independent work drains first, and the Kernel authorizes `schedule_replan`, whose only Runtime postcondition is that this Job is durably schedulable under the Decision-derived quiescence token. The Decision application is `applied` immediately with no Planner call, so no foreground TUI, Web connection or ConversationSession callback is required. An account-scoped Planner Worker claims the Job with a bounded Planner lease, performs one Planner turn, and inserts the `plan_proposed` event together with the `submitted` transition; the deterministic Job id and single conditional claim make a duplicate recovery pass idempotent. The Planner turn has a durable identity: the proposal event id is derived from the Job and the proposal is written to the Kernel inbox before the `submitted` transition, so a worker pass distinguishes "not yet planned", "proposal persisted" (reuse it) and "claim with unknown submission" (retry after the lease) and never re-plans a persisted proposal. A retryable Planner failure backs off and keeps the Job identity; past the absolute retry budget the Job fails closed as `planner_unavailable`, and recovery emits `recovery_required_observed` so the Kernel projects an explicit `block_work`.
_Avoid_: conflict-chain replan, per-attempt hidden retry, parallel Planner calls, foreground Planner callback

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
An Executor's structured request for one concrete operation outside its default AgentClass capability profile. Runtime canonicalizes it; the Executor/Host capability policy grants a bounded capability, denies with an Executor-visible reason, or escalates the exact request to user authorization. A granted request returns an opaque grant ID but does not itself widen execution authority or container sandbox policy. Runtime supplies versioned explicit rules: exact Task-registered read partitions, plus normalized public HTTP(S) targets only for the public-web-research profile; secrets and mutations are never profile-allowed. Kernel does not interpret this request.
_Avoid_: Planner resource claim, stderr parsing, broad permission prompt

**Capability Use**:
One attempt-bound audit-budget consumption of a previously granted capability. The Executor supplies the operation payload; trusted Runtime measures its UTF-8 size and atomically enforces attempt identity, expiry, call and byte budgets. This is not proof of universal operation mediation and does not add fine-grained authority beyond the selected execution backend and permission profile.
_Avoid_: universal capability broker, syscall enforcement claim, caller-declared byte count

## Desktop implementation boundary (2026-10-05)

Existing native Runtime adoption (2026-10-08): Desktop reuses a matching Web/TUI
release and provisions missing tools through its verified installer into
`desktop-support/<releaseId>`, without editing the active immutable release or
account configuration. A different installed release offers an in-app upgrade
using the downloaded app and the existing native updater's backups, schema
migration and rollback. Installer-only lifecycle calls work before Desktop
session support exists. Candidate commit still requires authenticated Desktop
rendering; a durable support helper permits repair without staged candidate code.
See ADR-0045 and the existing-runtime adoption implementation plan.

[ADR-0045](docs/adr/0045-desktop-thin-shell-and-local-session.md) accepts the isolated Desktop implementation: `apps/desktop`
loads the shared Web UI and connects to the canonical independent Server. The
local installation adapter is the only client exception allowed to invoke
formal Server lifecycle commands. Window close/desktop quit never stop Server.
Local desktop tickets are separate from browser login and workspace launch
hints. Implementation and release validation remain in progress; this is not
a signed desktop release announcement.


Desktop source checkpoint (2026-10-06): shared Web now consumes the optional
native directory/save/menu/preferences adapter. Account-scoped bounded drafts,
viewports and route hints persist independently of the HTTP port. The local
session exchange checks Unix ownership, release/instance identity and HTTP
proof; tickets never enter Renderer. Generic notification hints use a bounded
account feed, separate from Conversation observation and approval authority.
The signed-payload preparer consumes formal Runtime/Planner archives plus
explicit Node/Git/Pi distributions; installation and update helpers call the
existing native installer/updater. Joint activation waits for the new Server
identity and a new Desktop authenticated-render receipt before committing;
interrupted recovery does not depend on executing the staged candidate.
Desktop Pi provisioning covers engineering
and research without requiring optional Codex. Actual Electron/production-Web
smoke passed locally, including Renderer recovery and Server survival on client
exit. A distributable signed payload, clean-machine task acceptance, signed
joint-update tests, Intel validation and long-duration acceptance remain open.
This checkpoint does not declare a production Desktop release.

Release preparation (2026-10-07): v0.1.5 aligns Server/Web/Desktop versions and
requires the complete native/DMG asset set before latest promotion. Production
Desktop installation accepts user provider settings without developer internal
LLM provisioning; missing internal configuration disables only its optional AI
operations. Development provisioning remains separate. Publication and signed
acceptance remain pending; see `docs/plans/2026-10-07-v0.1.5-release.md`.


PDF/vision contract (2026-10-06): official DeepSeek Flash vision facts are applied
to new configuration candidates at the sole “保存并激活” boundary. Historical
revisions remain immutable. The shared Pi model renderer emits explicit text/image
input modalities. Executor uses installed system Pi and the reviewed MIT
`@joemccann/pi-pdf` 1.0.1 read subset; the vendored Planner receives no PDF tool.
The release bundles checksum-pinned standalone CPython and pinned PDF packages,
with no task-time package downloads or user-home extension/credential copying.
Existing pdf_* tools extract text/tables or render bounded pages for Pi’s existing
image read tool. Input is limited to 50 MiB, batches to 5 pages and images to 2048px;
there is no PDF wall-clock limit. Workers inherit the attempt process group and
AbortSignal cleanup; source/page checkpoints remain in the task workspace.

### Provider 显式协议（2026-10-13）

新增/编辑 Provider 必须保留 API 协议：`openai-compatible` 仍表示 Chat
Completions，`openai-responses` 表示 Responses，`anthropic` 表示原生 Messages。
配置层为 Pi/Planner 生成对应 adapter，通过既有私有环境引用注入凭据；不按
模型名称猜测协议。Anthropic 地址填写服务根地址（SDK 追加 `/v1/messages`），
OpenAI 地址填写 API 基础地址（一般含 `/v1`）。Codex 使用既有 Responses
adapter，配置验证拒绝 Codex/Anthropic 绑定；独立图像 Runner 继续使用 Images API。
连接去重包含协议、标准化 URL 和完整凭据身份。模型目录探测使用对应认证头；
保存仍经统一 revision/strict-idle 激活，不把目录获取或配置生效视为真实任务验收。
