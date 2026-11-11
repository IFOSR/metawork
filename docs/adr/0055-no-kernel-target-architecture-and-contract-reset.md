# ADR-0055: No-Kernel Target Architecture And Contract Reset

- **Status**: **Accepted (2026-11-07)** — product owner decision; the cross-review
  table is **waived**, not signed. The owner explicitly accepted the target
  architecture, the P-1..P-3 policy defaults and the removal scope recorded in
  §Decision ledger below. The audit/design documents referenced by the first draft
  are superseded by this ledger plus
  [target contract design](../plans/2026-11-07-metawork-target-architecture-contract-design.md),
  [reset implementation plan](../plans/2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md)
  and the [retrospective review](../plans/2026-11-07-metawork-product-convergence-retrospective-report.md).
  Acceptance authorizes the batches in the reset implementation plan; it does not
  authorize deleting a production path before its replacement batch is verified.
- **Date**: 2026-11-07
- **Scope**: Control flow, role ownership, Router dispatch, Manager permissions,
  Task/Attempt lifecycle and recovery ownership, durable facts after Kernel removal,
  role/protocol naming, Server network contract and the product/system boundary.
- **Supersedes on acceptance**: the strategic-authority portions of ADR-0020,
  ADR-0022, ADR-0023, ADR-0024 and ADR-0053; ADR-0052's Kernel boundary wording.
- **Amends on acceptance**: ADR-0015, ADR-0017, ADR-0018, ADR-0025, ADR-0026,
  ADR-0028, ADR-0032, ADR-0033, ADR-0034, ADR-0047, ADR-0048, ADR-0050 and
  ADR-0052 for the clauses enumerated in the design doc §12.1. ADR-0021,
  ADR-0035, ADR-0037, ADR-0040, ADR-0043, ADR-0045, ADR-0049 (memory),
  ADR-0051 and ADR-0054 keep their contracts.
- **Governed by/inputs**: [product requirements](../plans/2026-11-07-metawork-product-requirements.md),
  [convergence plan](../plans/2026-11-07-metawork-product-convergence-implementation-plan.md) §1,
  [technical implementation plan](../plans/2026-11-07-metawork-product-convergence-technical-implementation-plan.md),
  [retrospective review](../plans/2026-11-07-metawork-product-convergence-retrospective-report.md).
  Earlier draft review gates are superseded by the accepted Decision ledger;
  the product-owner waiver is recorded above, not a pending approval request.

## Decision ledger (2026-11-07, product owner waiver)

The following decisions are the authority for Phase 2–6 batches. Where the first
draft left an item open, the accepted default is recorded here.

| # | Decision |
| --- | --- |
| D1 | Retry/re-route: a provably idempotent failure (network, timeout, infrastructure) retries on the same route, at most 2 times; any other failure re-asks Router. `no_candidate` blocks that Subtask immediately with a structured fact for the Manager and never falls back to a default model. Re-routing consumes the Task's attempt budget and is visible in the trace. |
| D2 | Permission catalogue: hard deny = crossing the Host boundary (workspace-external read/write, elevation, bypassing the network/secret boundary, cross-account access); always escalate = spending money, sending externally, unrecoverable deletion, credential use; everything else is judged by Manager; unknown capability fails closed. Manager failure/timeout/invalid output escalates. |
| D3 | Partial success: only Planner-declared optional Subtasks may be absent from a successful result; a required Subtask that is not terminal means `failed`; partial results are summarized by Manager and projected by clients without local policy; an undelivered publication never renders as complete. |
| D4 | Usage and quota: `Included` covers only officially hosted model calls; a user-supplied provider key is `On-demand` (metered, not deducted from Included). Quota period follows the subscription cycle (monthly/yearly; trial is the exception). Missing provider usage is recorded as `provider_unavailable` with NULL tokens plus an alert, never as 0 or an estimate. Exhaustion rejects further hosted calls with purchase/BYO-key guidance and never stops a running Task. |
| D5 | Model price, cost, per-Task bill and amount-confirmation state are removed. Subscription/licence/payment facts stay in `official-server`. No historical amount export. |
| D6 | Pi: the packaged Manager and Executor both run the **upstream** Pi version installed on the packaging host at build time (currently `1.5.0`); the build records version and integrity in the release manifest and fails when `pi` is absent. `planner/AnyFusion-Pi` is removed. |
| D7 | Identity: everything is MetaWork. `MetaClaw` / `AnyFusion` names, `METACLAW_*` variables and the `metaclaw` / `anyfusion` CLI aliases are renamed or removed; no compatibility shim. |
| D8 | Kernel: `ControlKernel`, `DurableKernelWorkflow`, the decision ledger and replay are removed with **no** compatibility reader. Task/Subtask/Attempt/Result/Publication/Permission/Usage facts are kept under their new owners. |
| D9 | Persistence: fresh schema only. An old local database fails explicitly before any write with a backup path and reset instruction; no migration, export or partial open. `official-server` account/licence/payment data is independent. |
| D10 | Network: browser access requires account login; the existing login session is the transport (no new auth scheme) and Origin/CSRF validation is kept because it protects the browser surface. Wildcard bind with an empty allowlist refuses to start. TLS terminates at a reverse proxy; Server speaks HTTP. Internal endpoints (Planner bridge, memory sidecar, official local service, MCP) stay loopback/Unix socket. Config names: `server.host`, `server.allowedOrigins`, `server.trustProxy`. |
| D11 | Clients: `metawork` requires an explicitly started Server. Product clients are Web (this round), then macOS Apple Silicon Desktop and Feishu (deferred to the owner). The TUI entry, Ink UI and TUI-only flags are removed once Web is complete. |
| D12 | Isolation statement: the documented boundary is a trusted user process plus Host enforcement; there is no OS sandbox. The unused Docker attempt backend, Docker attempt images, egress proxy and Docker-only tests are removed. Linux sandboxing is the owner's later deployment concern and is out of scope here. |
| D13 | Windows: code is not deleted; the platform is declared unmaintained, receives no further updates, and release metadata says so. |
| D14 | Acceptance scope for this programme round: macOS arm64 local verification plus the Web client. Linux, Desktop and Feishu acceptance are deferred; nothing is pushed to GitHub before the owner reviews Web. |

## Context

Historical implementation note (2026-11-08, superseded by the 2026-11-10 D6
checkpoint below): production then still used Kernel dispatch and workflow
storage. This paragraph records the migration baseline, not current behavior. Manager permission context/usage is now connected at Server
composition, and Router persistence/concurrency has focused tests. Task
cancellation now fences Conversation Git enqueue/writeback and restart recovery;
partial writeback requires an explicit decision. See the
[local continuation record](../plans/2026-11-08-metawork-convergence-continuation-record.md)
for evidence and remaining removal gates. No local changes were committed or
pushed in this continuation batch.

Implementation checkpoint (2026-11-09, D2-3a): admission policy now belongs to
`src/execution/plan-admission-policy.ts`; the original ControlKernel plan policy
and candidate helpers are deleted. Account composition temporarily maps the
result to existing durable admission records. Deferred proposal storage uses an
explicit owner contract rather than KernelEvent. The inbox, applications and
plan event/action vocabulary remain until all Session/replan/recovery producers
and readers cut over together; this checkpoint does not satisfy D8. The
continuation record specifies that deletion gate and local validation.

Implementation checkpoint (2026-11-09, D2-3b-1): the replan worker now saves
Manager output in `task_plan_proposals` together with the fenced Job submission.
Its pending-delivery recovery reuses that output without consulting Kernel events
or calling Manager again. The existing admission transport still receives the
proposal through a temporary adapter; forwarded is not an authorization or graph
application result. Ordinary and merge proposals, direct application and removal
of the ledger adapter remain D2-3b-2 gates. This is a local implementation slice,
not a change to the no-compatibility-reader or fresh-schema target.

Implementation checkpoint (2026-11-09, D2-3b-2a): all ordinary and synchronous
replan/merge producers now persist prepared domain proposals before admission.
Preparation, original request and attachment-origin readers use their owner
store. Task creation binds the initial input in `task_plan_origins`; unadmitted
proposals cannot supply replan attachment eligibility. Replay preserves pinned
Workspace/Span, source Turn and Query facts. The old plan application transport
still runs. Conversation deletion fences late saves and erases proposals and
origin bindings together. Task/origin/graph atomicity plus autonomous initial-proposal
recovery remain D2-3b-2b work. No Kernel fallback reader was added; D8 is open.

Implementation checkpoint (2026-11-09, D2-3b-2b-1): a Conversation-owned durable
Turn cancellation fence is saved before abort/acknowledgement. Proposal save,
replay and application consult it across Session reconstruction; Task admission
rechecks after Workspace IO. Plan applications require their owner input, so
erasing a proposal cannot bypass the fence. Pending replan delivery invalidates
permanent lifecycle failures. Deferred availability activation checks the same owner before policy
evaluation and before graph application, retiring only the observed waiting output
on permanent refusal without starving other Jobs. Forwarded remains a receipt,
not an application result. This checkpoint is an admission prerequisite and does
not establish Task cleanup completion. Initial pending scans stay disabled until
Task/origin/graph/result atomicity and concurrent-commit fencing are implemented.
Kernel transport and applications still run; D8 remains open.

Implementation checkpoint (2026-11-09, D2-3b-2b-2b): admission now applies
atomically. `PlanAdmissionApplicationService` commits the Task, its initial
proposal origin, the authorized graph revision (Subtask and completion-requirement
materialization) and the applied admission result in one immediate transaction,
including the queue payload and Conversation slot claim; Workspace IO and
abandon-and-create stay outside it and the transaction re-reads the proposal
lifecycle fence. A graph that cannot be persisted rolls the whole admission back,
and an already-recorded outcome replays without a second Task, graph, queue entry
or slot claim. Execution now recovers the admitted revision instead of applying a
second graph. The plan ledger adapter, plan events and Kernel-driven application
still run, so plan ledger rows still grow and D8 remains open.

Implementation checkpoint (2026-11-09, D2-3b-2b-2a): a Work Graph revision no
longer carries a Kernel foreign key; `work_graph_revisions.authorized_decision_id`
is an operation identity (`WorkGraphRevisionRecord.authorizedOperationId`), the
current-version database is rebuilt once to drop that constraint, and Task/
configuration constraints stay. Task Runtime now owns the applied admission
outcome in `task_plan_admission_results`: authorized, queued, rejected,
clarification, direct reply and no-action conclusions are recorded once per
`admission_<planId>`, an identical replay is a no-op and a different conclusion
conflicts. Delivery receipts stay receipts. Graph application still happens
inside `prepareExecution`, so Task/origin/graph/result atomicity, deferred
results, autonomous initial-proposal scans and deleting the plan ledger adapter
remain open. D8 is not satisfied by this slice.

Implementation checkpoint (2026-11-09, D2-3b-2c): ordinary Conversation and
retained-Session submissions, the background replan worker and account
startup-recovery delivery now evaluate the single admission policy themselves and
apply it through `SessionKernelRuntime.applyPlanAdmission`; no plan event,
decision or application row is written on those paths. Applied outcomes
(`authorized|queued|deferred|rejected|clarification|direct_reply|no_action|
task_control|permission_resolution`) are recorded once per `admission_<planId>`,
replays emit no duplicate reply or question, deferred admission writes the
availability fact and Task block directly, and query cost attribution uses the
admission operation identity. The Kernel plan family survives only for the replan
effects D5 still triggers (`request_replan`/`request_merge_replan`), which reuse
the same owner applier; the plan ledger adapter and plan event vocabulary are
deleted with that D5 migration. D8 remains open.

Implementation checkpoint (2026-11-09, D2-3b-2d): the last plan-event producers are
gone. Replan effects that a Kernel decision still triggers (`request_replan`,
`request_merge_replan`) now prepare the proposal and admit it directly, returning
no event; the client-less recovery replanner resolves the owner applier lazily and
does the same. Account composition no longer wraps ControlKernel with the plan
adapter, so no production path decides `plan_proposed` and the plan ledger stops
growing entirely. The Manager read model reads `task_plan_proposals` plus
`task_plan_admission_results` instead of Kernel decisions. What remains is dead,
unreachable plan transport (the adapter, the `plan_proposed`/`plan_admission`
vocabulary and its recovery/execution branches) and the tests bound to it, deleted
with D6 when `src/kernel/*` goes. D8 remains open for the other decision families.

Implementation checkpoint (2026-11-10, D6 delivered): the Kernel control axis is
gone. `ControlKernel`/`DurableKernelWorkflow` no longer exist as symbols; the whole
control round is decided by `ControlLoopPolicy` inside `TaskControlWorkflow`, a
serial in-process drain with no event inbox, no decision/application ledger and no
replay. Every decision is applied immediately through an idempotent Runtime handler,
duplicate events are deduplicated in memory, and an interrupted application leaves
exactly one `task_recovery_items` row that startup reconciliation, `/task recovery`
and resolver operations read. `kernel_events`, `kernel_decisions` and
`kernel_decision_applications` are dropped from the fresh schema and from the
schema-30 upgrade path; their repositories, event-content codec, read models,
projections, deletion redactions, permission anchors and residue checks are deleted
or re-pointed at owner facts. The remaining modules were renamed with the contract:
`src/kernel/` became `src/control/` (contracts, settlement, failure normalization,
Task scheduler, routing eligibility), the Task Runtime-owned tables lost the
`kernel_` prefix (`dispatch_items`, `effect_outbox`, `executor_status`,
`provider_status`, `model_status`, `binding_status`, renamed in place by the 65→66
step), and every `Kernel*` identifier is now `Control*`.

`src/control/control-contracts.ts` is transport only: the event/decision/snapshot
shapes, the `decision()` factory, `guardControlDecision()` and
`snapshotMatches()`. The 19 former `decide*` families now live in
`src/execution/*-policy.ts` behind `ControlLoopPolicy`, and the durable workflow
that persisted and replayed the ledger is deleted.

Implementation checkpoint (2026-11-10, usage review R-08–R-10): the Web account
usage surface and authenticated `/api/usage/timeline` now use the Metering owner
read model, Beijing calendar intervals and exact canonical Token totals. The same
account-wide platform facts drive quota guidance/preflight across all agent roles.
Pi ingress adds raw input, cache reads and cache writes once, retaining cache as
subsets; reasoning remains a subset of output. This is a projection and adapter
repair checkpoint: monetary storage/configuration/API deletion, comprehensive
supported-call coverage and production quota/provider data remain open. See the
[review report](../plans/2026-11-10-metawork-full-code-review-report.md).

Implementation checkpoint (2026-11-10, ownership review R-14/R-16): Manager
planning/permission and Executor usage now resolve Provider ownership from the
call's pinned configuration, including historical snapshots loaded on recovery.
Unknown ownership stays unknown; active settings and default payer cannot fill
it in. Manager quota preflight reuses actual model selection and clears stale
notices, keeping user-owned Provider calls outside Included guidance. This does
not close comprehensive call coverage or the remaining monetary deletion gates.

Implementation checkpoint (2026-11-10, installation review R-17): build-source
metadata accepts omission of the vendored Planner path, and configuration probes
recognize the managed Pi executable resolved by Manager. This fixes false
readiness failures. R-18/R-20 now replace fork build steps with relocatable
pinned upstream Pi packaging, require the managed executable, and create Pi-only
source defaults. Codex outside source defaults, full signed-release integrity
and clean-machine Manager/Router/Executor acceptance remain open gates.

Implementation checkpoint (2026-11-11, real Admin Web follow-up): the packaged
Pi Manager extension explicitly connects its allowlisted context-read tool to
MetaWork's read-only MCP process. An isolated `mcp.json` alone does not expose
tools in upstream Pi. Composition owns database/configuration/account paths;
the transport pins Conversation, Planner session and configuration revision
per turn. Model arguments cannot override these identities, and provider
credentials do not cross into the read service. Permission and final-summary
turns expose only their respective proposal tool. This implements the existing
tool-mediated context boundary; it adds no storage writer or semantic router.
Certified multi-subtask completion uses a detached Manager summary turn and
the authoritative original user input. An authorized interrupted completion
can resume from certified results without rerunning Executor attempts. Memory
or resource references that fail before launch with no external effects use
the existing bounded generation-replan policy, not route exclusion.

The same-day completion follow-up keeps immutable Result Object metadata intact:
a completed contract-correction receipt certifies only its identity-verified
source safe projection, including an original partial marker. Completion
recovery is reported separately from uncertain external effects. Invalid
Manager context references return bounded repair feedback before admission,
without becoming fabricated user clarification. Web trajectory and Conversation
cards consume the same current TaskView; oversized progress history is compacted
at the existing Gateway response boundary, with detailed trace still paged.
See the [completion/status repair record](../plans/2026-11-11-task-completion-status-consistency-fix.md).

Implementation checkpoint (2026-11-10, review R-19/R-21–R-24): control event
state distinguishes queued/applying/applied/uncertain; shared callers await the
drain, pre-apply failure permits retry, and uncertain applications remain fenced
against automatic replay even when recovery recording fails. Empty-drain enqueue
races are covered. Admission spans carry unknown payer until actual model usage.
Token read models iterate account-scoped SQLite facts with exact arithmetic,
with a 100,000-row regression; call replays cannot change Provider/model/Task
attribution. Account Router wiring now supplies live owner reads inside the
append transaction and does not substitute the original suggested binding when
a persisted selection disappears. These fixes do not close full semantic owner,
historical usage, latency or release acceptance gates.

Implementation checkpoint (2026-11-10, review R-25–R-28): model settings and
Memory no longer display price estimates; obsolete amount components and the
price-required activation/admission gates are removed. Price-free configuration
activation has an integration regression. Native smoke only accepts packaged Pi,
reads Manager/Executor fixtures independently and diagnoses recovery facts instead
of a deleted Kernel table. Local Docker/test publishing assets and the unused
container adapter are removed; native process reconciliation and hard-deny rules
remain. Executor creation/edit/enable and readiness discovery now expose only Pi;
unsupported executors cannot be newly enabled through the management API. Legacy
Codex/container configuration types and remaining monetary storage/API deletion
remain open. The review report records actual validation, not full PRD acceptance.

Implementation checkpoint (2026-11-10, review R-33–R-40): proposal
preparation treats a cancelled Turn as "no proposal" and disposal/shutdown as a
recoverable interruption instead of a preparation failure. The fresh schema now
declares every column the storage layer writes (`retry_wakes.session_id` was
missing) and a repository-column audit guards that invariant. Router persistence
re-reads Executor availability inside the append transaction and records
`provider_unavailable` exclusions, so a decision cannot commit against a health
fact that changed during the model call. Usage facts treat source id, provider
response id, normalization version and occurrence time as immutable call
identity. Span decision-model usage keeps tokens only; provider money values are
ignored. Startup schema validation names missing/extra objects, and installation
preflight refuses a prepared activation whose previous database is not current.
Full-suite regression is green. Router decision-model calls are recorded as
`system`-payer usage facts (one per actual call, replay writes none, missing
adapter usage stays explicitly missing) so they never consume a user's Included
quota. Memory extraction/scene/persona calls are recorded from the engine's own
bounded ledger through the release-owned compat patch and its authenticated
drain route, attributed to one account-level system Query with the payer
resolved from the extraction Provider's ownership. Real-provider tasks and
release-grade acceptance remain open.

The product no longer wants a Kernel: Router decides Agent and model per Subtask
and dispatches directly; Manager (formerly Planner) owns meaning, decomposition,
summary and permission judgement; Executor/Host owns tools and enforcement.
ADR-0053 already moved capability policy to Executor/Host but kept the Kernel as
a migration implementation, leaving the strategic interface, ledger and replay
paths alive. That is a second policy interpreter and a second dispatch approval.

Deleting the Kernel is therefore not deleting Task persistence. Every Kernel
responsibility must first receive one owner and one behaviour, and every fact the
replacement runtime still needs must stay. This ADR fixes that split.

## Decision

### 1. Product control flow

```text
User -> Manager: understand intent, propose Work Graph (no Agent/model fields)
      -> Task Runtime: admit, validate, persist graph revision
      -> Router: per ready Subtask decide {Agent, model, reason}
      -> Task Runtime: persist route decision, claim, launch Executor
      -> Executor/Host: perform the authorized work inside enforced boundaries
      -> Task Runtime: receipts, lifecycle, publication, mechanical recovery
      -> Manager: assemble the Task result for the User
```

Three roles only: **Manager**, **Router**, **Executor**. The Kernel role does not
exist. `Work Graph` is a pure rule module, `Task Runtime` is an application/runtime
module, `Host` is an enforcement boundary, `Storage` is an adapter and the
`Application Shell` owns admission and client projection.

### 2. One owner per concern

| Concern | Owner | Explicit non-owner |
| --- | --- | --- |
| Turn/Conversation admission and Task creation | Application Shell + Task Runtime admission contract | Router, Manager |
| Intent understanding, graph proposal, replan semantics, final summary | Manager | Task Runtime, Router |
| Graph schema, DAG, dependency and frontier rules | Work Graph | Manager, Runtime |
| Agent/model selection per Subtask and its rationale | Router (decision model) | Manager, Task Runtime, Kernel |
| Route persistence, candidate facts, dispatch identity | Task Runtime | Router (no direct writes) |
| Task/Subtask lifecycle, attempt lifecycle, leases, cancellation | Task Runtime (`src/task`, `src/execution`) | Manager, Router |
| Executor tool surface, turn loop, tool retry/repair | Executor/Harness | Router, Task Runtime |
| Permission semantics (approve/deny/ask user) | Manager | Router, Executor |
| Permission record, scope validation and application | Permission Service (`src/resource` + `src/execution/permission-workflow-service`) | Manager (no writes), Executor |
| Permission enforcement | Host/Executor process boundary | Manager, Router, Task Runtime |
| Completion certification and safe result delivery | Delivery/Completion (`src/delivery`, Task Domain) | Kernel, Router |
| Workspace publication, merge order and conflict repair request | Task Runtime publication worker | Kernel, Manager (semantics only) |
| Token usage fact per model call | Metering (`src/metering`) | Billing prices, Kernel |
| Server bind, authentication, allowed origins, internal loopback | Server/Gateway | Manager, Router |
| Restart recovery mechanics | Task Runtime startup recovery (`src/account` entry, `src/execution`) | Kernel ledger replay |

The D6 checkpoint accepts `ControlLoopPolicy.decide(event, snapshot)` as an
in-process Task Runtime lifecycle facade over named owner policies. It is not a
separate strategic role, durable inbox/decision ledger, replay engine or second
approval of Router output. Each semantic concern retains the owner above;
Manager proposal interpretation and Agent/model selection must not migrate into
this facade. Runtime's surviving preselected binding policies remain a convergence
gap to be removed with the Manager/Router contract cutover, not a new authority.

### 3. Router contract

Router consumes catalog facts (AgentClass capability profile, model catalog,
eligibility, configuration revision) plus the Subtask goal and acceptance criteria,
and publishes one `RouteDecision` per Subtask attempt identity:
`{routeDecisionId, taskId, generationId, subtaskId, graphRevision,
candidates+exclusions, selected {agentClassId, modelId}, reason, decisionModel
identity, configurationRevision, createdAt}`.

- The decision is final for that attempt; there is no Kernel or second approval.
- `no_candidate` is an explicit decision with a reason. The Task Runtime blocks the
  Subtask and the user sees "no eligible executor for this Subtask". No silent drop
  and no unbounded retry.
- Router does not write SQLite, mutate Task state, start processes, or widen any
  permission. Task Runtime persists and dispatches.
- Route identity and reason are persisted and projected into the trace so a user can
  review why an Agent/model was used.
- Routing determinism is **not** a product acceptance requirement (see the PRD
  conflict recorded in the design doc §4.7). Reproducibility of the recorded
  decision and its candidate snapshot is required instead.

### 4. Manager permission judgement

Three flows are normative: Manager grants, Manager denies, Manager escalates to the
user. The Manager owns the semantic judgement of "does this Executor request match
the user's intent". It does not own the authorization record and cannot enforce.

Security invariants:

1. The Executor states the exact capability it needs. The Permission Service
   normalizes it, computes its fingerprint and binds Account, Workspace,
   Conversation, Task, generation, Subtask, Attempt, permission request, requested
   partition/operation/scope, configuration revision and permission profile.
2. Hard-deny rules are evaluated before any model judgement. Requests for platform
   credentials, another Task's secret/workspace, sandbox weakening, permission-policy
   or ledger modification, host devices/namespaces, privileged containers or
   bypass brokers never reach the Manager and are never granted to a model decision.
3. Always-escalate capabilities (`sealed_secret`, `external_object_operation`,
   `repository_promotion`) go to the user; the Manager cannot approve them.
4. A decision can only narrow or equal the request. Neither Manager, Router, user nor
   Task Runtime can widen a capability or the Host boundary.
5. Uncertainty is never approval. Unknown capability, missing/stale request revision,
   ambiguous scope, unreadable profile or an unverifiable fingerprint produces
   `escalate` or `deny`.
6. Duplicate or concurrent decisions are resolved by request identity and revision;
   the loser is rejected, not applied twice. Expired requests deny by default. A
   Manager process exit leaves the request pending. Restart reconstructs requests from
   durable facts and never auto-approves. An uncertain grant application fails closed
   and becomes an explicit recovery item.

### 5. Durable facts after Kernel removal

Authoritative facts remain durable and owned: Account/Workspace/Conversation/Turn,
Work Graph revision, Task/Subtask/Attempt lifecycle, route decision, attempt receipt,
permission request/decision, Result Object/Reference and completion certification,
workspace change record/publication delivery, model-call token usage, and the
operation identities needed for idempotent recovery.

The Kernel ledger is removed: `kernel_decisions`, `kernel_events`,
`kernel_decision_applications`, `effect_outbox`, Kernel event/snapshot
vocabulary, Kernel replay and the Kernel status projection. The fresh database uses
one schema contract version and no per-version upgrade chain: an existing local
database of any earlier version is rejected with explicit reset instructions and is
never silently migrated or deleted. Official account, license, subscription and
payment authority stays in `official-server`; it is not removed by local data reset,
and model usage is accounted in Tokens while commercial amounts remain payment facts.

### 6. Naming and protocol

- Product roles are Manager, Router, Executor in types, persisted role fields, events,
  errors and clients. "Planner" is no longer a product role name.
- Upstream component attribution and required notices remain intact. D6 removes
  the vendored `planner/AnyFusion-Pi` fork and packages upstream Pi instead;
  `src/planning/manager-host` owns Manager integration. Retired TUI bridge
  cleanup remains tracked separately. `METACLAW_*`/`ANYFUSION_*` environment aliases collapse into
  `METAWORK_*`; no compatibility reader is retained.
- Server and clients ship the same protocol version. A mismatched client is rejected
  with an explicit upgrade message; the Server never serves two protocol versions.
- Role renaming and the fresh schema land together so no dual-write planner/manager
  layer is ever introduced.

### 7. Server network and product/system boundary

Server supports a configured listener (loopback, wildcard or one explicit IP),
mandatory authentication and authorization on any non-loopback listener, a
configurable allowed-origin list, and loopback-only internal services. This ADR does
not choose a cloud or local deployment shape and does not produce deployment assets.

Three Docker scopes are separate: local user runtime and Docker-only test
assets are retired under D12 after maintained-host native verification; Linux
acceptance is deferred by D14 and is not a prerequisite to that deletion. The
`official-server` deployment image stays under its own owner and exit gate.

## Responsibility and failure attribution

Failure attribution follows the owner that produced the fact: no candidate or bad
route → Router; wrong or missing authorization record → Permission Service; boundary
violation → Host; lifecycle, lease, publication and recovery inconsistency → Task
Runtime; semantic mismatch with user intent → Manager; usage gap → Metering. No
failure is attributed to "the system". Product policy that the requirements do not
yet define (automatic retry/fallback order, permission red-line catalogue beyond the
platform hard denies, aggregate partial-result presentation) is recorded as a
blocking product decision owned by the product requirements owner; the interim
behaviour is fail-closed and explicitly visible, never a copy of the retired Kernel
policy.

## Migration and deletion

1. Author the client projections, trace facts and tests for route decisions and
   Manager permission decisions (no deletion yet).
2. Implement Router direct dispatch and the Task Runtime ports; keep retired Kernel
   paths callable only until their owner tests pass.
3. Move Task lifecycle, retry mechanics, completion, cancellation, publication and
   recovery to the Task Runtime ports; keep their durable facts and idempotency keys.
4. Delete `ControlKernel`, `DurableKernelWorkflow`, Kernel events/snapshots/decisions,
   Kernel ledger tables, Kernel replay/recovery and Kernel-specific projections and
   tests. Delete `span-routing-advisor` after the Router contract and trace land.
5. Replace the migration chain with the single fresh schema; reject older local
   databases explicitly.
6. Update the superseded ADRs, `CONTEXT.md`, technical overviews and operational
   handbooks as one reviewed documentation change set.

Duplicate decision paths, Kernel compatibility APIs, decision replay, dual-write
planner/manager fields and a renamed "coordinator" holding the same central policy
loop are all prohibited.

## Acceptance

- No production or test path calls a Kernel decision interface, and no second policy
  interpreter or dispatch approval exists.
- Every Subtask carries a persisted route decision with Agent, model and rationale,
  visible in the trace; no-candidate Subtasks are explicitly blocked.
- Manager grants, denies and escalates through the Permission Service; hard denies
  cannot be overridden by any model; grants apply only to the exact request.
- Task/Attempt/Result/Permission/Workspace/Usage facts have one owner and survive
  restart with idempotent application and explicit unknown-effect recovery.
- Token usage is recorded per model call; no model price or amount state remains.
- Non-loopback Server listeners keep authentication, authorization and origin checks;
  internal services stay on loopback.
- Fresh installs create the single schema version; older local databases fail with
  reset instructions. Official account/payment authority is untouched.
- The affected ADRs, current docs and archived-plan boundaries are reviewed by the
  owning reviewers before implementation batches start.
