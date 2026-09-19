# ADR-0033: Hot Configuration Activation And Auto Model Routing

- **Status:** Accepted
- **Date:** 2026-08-23
- **Scope:** AccountRuntime configuration activation, Planner/Executor model
  routing, and read-only Work Graph presentation
- **Affected ADRs:** ADR-0027, ADR-0028, ADR-0031

## Decision

Provider and Model catalog facts, Provider credential references, AgentClass
model policies, Auto routing objectives, and AgentClass routing use-case hints
(`primaryUseCases` / `avoidUseCases`) are hot-activatable at the AccountRuntime
boundary. Use-case hints guide AgentClass choice and are re-resolved from the
current active revision before each Planner turn, so they do not require a
Server restart. Process artifacts remain restart-required: application
release, SQLite schema, Harness command/driver/image/transport, Permission
Profile semantics, Planner RPC protocol, and runtime directory protocol.

`ConfigurationActivationGate` is the authoritative admission check for
activation. It combines in-memory Planner/Runtime activity with durable Task,
Dispatch, Attempt, Lease, Publication, and recovery facts. Connected clients
and idle `ready`, `parked`, or `blocked` Tasks do not block activation. The
backend rechecks the gate while holding one activation mutex; UI disabled state
is not authorization.

`ConfigurationRuntimeCoordinator` validates and probes an immutable candidate,
performs the optimistic active-revision check, renders the revision-scoped
runtime before pointer cutover, atomically updates the live Planner/Kernel/
Runtime views, and publishes runtime-state and activation events. Planner
credential writes are deferred until candidate validation has passed and are
never part of draft preparation. Existing Work Graph generations, attempts and
receipts retain their original revision and concrete binding.

Auto is a selection policy, never a runtime model. `AutoModelResolver` filters
only revision-authorized candidates and fails closed on disabled Provider,
disabled or incompatible Harness, unavailable capacity, health, capability,
context, cost, latency, or quality violations. It returns a concrete
Provider/Model/AgentClass/Harness/Permission Profile/revision binding plus
ordered fallback and redacted rejection/score facts. ControlKernel owns
Executor resolution and fallback; Execution transports only the authorized
binding. Planner resolves a concrete binding before each RPC prompt from the
current active revision and structural input facts such as text size, image
MIME/size, attachment count, and continuation.

`WorkGraphPresentationProjector` is a read-only Application Shell projection.
It consumes validated graph and durable Kernel/Dispatch/Attempt/Verification/
Publication facts and exposes dependencies, handoffs, artifact edges, parallel
groups, runnable frontier, routing policy, concrete binding, score facts and
rejected candidates. Web components may render or refresh this projection but
may not mutate graph state, schedule/cancel attempts, change bindings, or
bypass Kernel.

### Provider-first settings amendment

The user-facing source of model candidates is the model directory maintained
inside each Provider. The internal `ModelProfile` projection remains available
to Planner, Kernel, Runtime, and revision-pinned bindings, but it is not a
separate editable settings resource.

Planner AgentClass policy is fixed-only and must reference one enabled catalog
model. Codex Executor Auto uses GPT-family models across enabled Providers;
Pi Executor Auto starts from all enabled Provider models. The user's selected
Auto pool is the final policy input, and the shared configuration candidate
projection applies the system compatibility filter before `AutoModelResolver`.

When the activation gate is idle, Provider and model deletion is allowed even if
the item is currently referenced by a Fixed policy. Deletion removes Auto pool
references but does not silently replace Fixed references; the draft is invalid
until the user selects a new model. Busy deletion/activation is rejected by the
backend with `runtime_busy`, while an unrepaired draft returns
`invalid_configuration`.

### Unified Executor capability profile amendment

Each enabled Executor has one independent capability profile per immutable
configuration revision. Candidate compilation combines its effective
ModelPolicy, Model capability evidence, controlled Executor affordances, and
persisted user semantics. It then atomically projects:

- the Chinese Skill-style capability manual;
- read-only best-fit and avoid tags;
- supported, unresolved, and disposition evidence;
- the Planner-safe Routing Catalog entry and profile fingerprint;
- the Kernel-safe routable capabilities used for concrete resolution.

The manual and Catalog are not separately editable or independently derived.
The final manual is Planner's authoritative semantic routing profile, and the
Catalog is the machine-readable projection used for validation. User semantics
override conflicting generated positioning and preferences, while structural
model and Executor evidence remains mandatory. A user can disable supported
qualification or mark it `avoid`; user text cannot create an unknown capability,
authorize an unconfigured Model, or widen Permission Profiles.

Model selection changes mark the draft profile stale. Preview recompiles model
evidence even when optional natural-language interpretation is unavailable.
Activation recompiles the profile on the backend and atomically switches the
profile, manual, Catalog, ModelPolicy, and generated runtime artifact with the
new revision. Existing Work Graph generations retain their pinned revision.

### User-facing settings and local readiness amendment (2026-09-16)

The ordinary Web settings surface presents Provider entries as models and
Executor/AgentClass entries as agents. `Provider`, `Executor`, `AgentClass`,
Harness, `SecretStore`, `apiKeyRef`, and stable internal references remain
technical contracts and are not required user vocabulary. Provider and
AgentClass definitions may carry an optional revision-scoped `displayName`;
renaming changes presentation only and never changes routing identity,
historical bindings, or capability ownership.

Production Provider credentials are authoritative in the one
`<metawork-root>/credentials.json` file, defaulting to
`~/.metawork/credentials.json`. The Web surface accepts a Key only on write,
returns configured state plus a mask, and permits replacement. The existing
`SecretStore` interface remains the runtime seam, while the production
implementation resolves Provider references through this file. No separate
`~/.config/metawork` persistence root is introduced.

Application Shell owns local agent installation readiness. Pi is required only
for admitting new work; missing Pi does not block login, Workspace access,
history, settings, or readiness refresh, and does not cancel running Tasks.
Codex is optional. Its missing state explains the additional GPT/Codex model
compatibility and coding benefits but never blocks work or implies that Pi
lacks coding capability. Readiness is projected through Management and the
unified Gateway and is not Kernel Executor health.

### Executor idle management amendment (2026-09-19)

This amendment supersedes the earlier allowance that idle `ready`, `parked`,
or `blocked` Tasks do not block activation. Configuration writes are admitted
only under the strict idle rule: any Task in `created`, `ready`, `running`,
`parked`, or `blocked` that can still continue, any in-progress Planner turn,
any accepted-but-unprocessed work request, execution, result verification,
publication, cancellation cleanup, and startup or periodic recovery each mark
the account busy. `done`, `archived`, and `cancelled` Tasks block until their
cleanup has completed. Unknown or unconfirmable activity states fail closed
and reject the write with diagnostics. Connected clients, history browsing,
settings reads, logins, and task cancellation requests are not new work.

New-work admission and configuration transactions share one account-scoped
interlock. A business request holds a work reservation continuously from
authenticated admission through Planner completion or Task persistence, so no
"not yet `beginWork`" window exists. If work is reserved first, configuration
writes return `runtime_busy`; if the configuration transaction starts first,
new work is explicitly rejected with a configuration-updating reason rather
than silently dropped or started. The configuration transaction holds the same
interlock across validation, manual compilation, probe, activation, in-memory
refresh, and compensation; transaction-owned analysis and probe steps run
inside that context and are not counted as ordinary business work. UI disabled
state remains non-authoritative. If activation compensation cannot prove the
previous active/runtime revision, credentials, and catalogs were restored, the
account stays blocked for new work instead of releasing into a false idle.

Executor AgentClass lifecycle operations — create, update, enable, disable,
remove — for Executors backed by existing `pi-cli` / `codex-cli` Harness
configurations are hot-activatable while strictly idle, subject to the field
bounds in ADR-0028. Changing an Executor's tool, adding or removing a Planner
AgentClass or changing its type, and Harness command/driver/image/argument or
Permission Profile grammar changes remain outside ordinary executor
management. Shared credential writes, Provider/Model mutations, full
configuration activation, and rollback all pass through the same strict gate;
read-only credential queries never import or replace keys as a side effect,
and automatic credential import runs only inside a protected initialization or
configuration transaction.

**2026-09-19 scope adjustment:** the owner explicitly deferred CLI administration
to its upcoming redesign. The existing CLI admin path is unchanged and is not
covered by this delivery's live-Server gate. Until that redesign removes direct
file writes, operators must not run CLI configuration mutations alongside a live
Server. The target remains authenticated live-Server administration with no
offline write fallback.

Web/Management now expose bounded preparation and confirmation through the
existing activation transaction. Nested service activation is authorized by
transaction-local ownership, not a caller's boolean alone. Manual compilation
and shared Key writes hold the account gate; credential reads are side-effect
free. Failed compensation latches a recovery-required block until service
restart/recovery. Passive notification failure does not undo committed state.

This amendment also supersedes the fixed Pi-required/Codex-optional installation
rule above: required tool installation is derived from currently enabled
Executor Harness drivers. Installation cards identify tools, not one assistant
sharing that tool. No enabled Executor rejects new user work with
`no_enabled_executor`; creating/browsing Conversations remains available.

## Consequences

- A successful idle activation affects the next Planner turn and new
  generation/attempt only; it never rewrites a running process or historical
  binding.
- API responses expose both active/runtime revisions and structured busy or
  restart-required reasons.
- Auto routing is explainable and replayable without exposing credentials,
  prompts, raw process output, or hidden reasoning.
- Configuration completion may use only the active revision, bounded local
  Agent credential discovery, explicit Provider catalogs, presets, and safe
  metadata. Unknown capabilities remain unsupported and require confirmation.
- Adding or removing an effective Model adds or removes its profile-derived
  Routing Capabilities, evidence, tags, manual statements, and Catalog
  qualification in the same revision.
- Rollback is another revision activation and obeys the same gate and
  optimistic-concurrency rules.
