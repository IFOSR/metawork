# ADR-0033: Hot Configuration Activation And Auto Model Routing

- **Status:** Accepted
- **Date:** 2026-08-23
- **Scope:** AccountRuntime configuration activation, Planner/Executor model
  routing, and read-only Work Graph presentation
- **Affected ADRs:** ADR-0027, ADR-0028, ADR-0031

## Decision

Provider and Model catalog facts, Provider credential references, AgentClass
model policies, and Auto routing objectives are hot-activatable at the
AccountRuntime boundary. Process artifacts remain restart-required: application
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
- Rollback is another revision activation and obeys the same gate and
  optimistic-concurrency rules.
