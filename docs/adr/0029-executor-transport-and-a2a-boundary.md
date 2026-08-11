# ADR-0029: Executor Transport And A2A Boundary

- **Status**: Accepted
- **Date**: 2026-08-11
- **Scope**: ExecutorAdapter transport boundary, transport-neutral authorized attempt envelope, and future A2A deferral
- **Amends**: ADR-0020, ADR-0023, ADR-0024
- **Related**: ADR-0018, ADR-0021, ADR-0025, ADR-0026
- **Governed by**: ADR-0020

## Context

The server upgrade needs a stable Executor seam that can later carry remote
execution. The revised design names A2A as the likely future remote Executor
transport, but it also keeps the product control axis unchanged:

```text
Planner -> Kernel -> Runtime -> ExecutorAdapter -> transport
```

Treating A2A as another Planner ingress, scheduler, router, retry loop or
recovery controller would duplicate the Control Kernel and durable Runtime
workflow. It would also let transport uncertainty make strategic decisions that
MetaClaw already records as Kernel facts.

This release therefore does not deliver A2A. It delivers only a
transport-neutral authorized attempt seam and records the boundary a future A2A
adapter must respect.

## Decision

### 1. A2A Is Only A Future ExecutorAdapter Transport

A future A2A integration may exist only behind the existing `ExecutorAdapter`
port. It may map one Kernel-authorized attempt to a remote protocol request,
observe progress by stream or poll, relay a cancel request for that same attempt,
fetch artifact references, and normalize transport or remote-process failures
into Runtime facts.

It may not:

- accept a Planner proposal directly;
- select an AgentClass, Harness, Model, binding or permission profile;
- derive fallback candidates or change candidate order;
- schedule, queue, prioritize, preempt or admit work;
- decide retry, continuation, recovery, replan, block, park or Task completion;
- write Task/Subtask state, Work Graph state, Kernel ledger entries or resource
  grants directly.

The only allowed control path remains:

```text
Planner proposes
  -> Kernel authorizes a Decision
  -> Runtime applies the Decision
  -> ExecutorAdapter transports one authorized attempt
  -> Runtime reports normalized facts
  -> Kernel decides any next strategic action
```

### 2. Authorized Attempt Envelope Identity

Runtime owns the authorized attempt envelope. It is created only after a Kernel
Decision has been durably applied and is immutable for one adapter invocation.
It is not a Planner plan and not a user-originated remote job request.

The stable envelope identity is the tuple:

```text
attemptId
generationId
configurationRevision
bindingFingerprint
idempotencyKey
```

The envelope must also bind, at minimum:

- Task, Subtask and WorkUnit identity;
- the exact authorized AgentClass;
- the exact authorized Harness and Model binding;
- the authorized permission profile;
- attempt-scoped resource leases and capability grant references;
- workspace, context and dependency-handoff references selected by Runtime;
- artifact provenance and integrity requirements;
- the adapter/backend kind selected by Runtime.

A transport may add its own connection IDs, message IDs or remote job IDs, but
those are observations, not authority. They cannot replace `attemptId`, weaken
the envelope binding, or become Kernel policy inputs except through normalized
Runtime facts.

### 3. Idempotency

The `idempotencyKey` identifies one exact authorized attempt request. It is
stable across reconnect, process restart and identical retransmission of the
same envelope. A future remote endpoint must treat repeated submission of the
same key and byte-equivalent request as one job and return the existing accepted,
running or terminal observation.

The same key with a different envelope, payload, binding, grant set or artifact
policy is a conflict. A different key for the same `attemptId` is invalid unless
Runtime has created a distinct Kernel-authorized attempt. Transport-level
retransmission under the same key is allowed only to resolve delivery
uncertainty; it is not an Executor retry and must not allocate a replacement
attempt.

Runtime recovery may replay observation of the same envelope. The adapter must
surface prior accepted, running, terminal, cancelled or uncertain state rather
than silently starting new work.

### 4. Trust And Authentication

A2A transport authentication and Kernel authorization are separate gates.
Transport credentials prove only that MetaClaw may talk to a remote endpoint.
They do not authorize a Task, widen a permission profile, select a Model, or
make a remote result trusted.

A future A2A adapter must verify:

- the remote endpoint identity against a versioned trust root;
- that the request envelope was issued by the local Runtime for the
  generation-pinned configuration revision carried by the envelope;
- that the binding fingerprint, AgentClass, Harness, Model and permission
  profile match the authorized envelope exactly;
- that any remote receipt or artifact manifest is bound to the same envelope
  identity;
- that expired, revoked, downgraded or unknown trust material fails closed.

Remote executors never receive provider credentials, storage credentials or
configuration authority merely because the transport is authenticated. They get
only the attempt-scoped material and grants Runtime explicitly includes.

### 5. Cancel, Disconnect And Uncertain Outcomes

Cancel is an attempt-scoped adapter operation. It may be initiated only through
Runtime applying a Kernel-authorized cancellation path. A remote A2A endpoint may
acknowledge, reject or race with completion, but it does not decide Task
cancellation or Subtask terminal state.

Stream loss, poll timeout, process crash, connection reset or missing remote
acknowledgement cannot be normalized as success or retried as a new attempt. If
the adapter cannot prove whether the remote accepted, completed, cancelled or
persisted the job, it must report an `uncertain` transport observation with the
same envelope identity and last trusted remote reference.

A late terminal observation is usable only when it proves the same envelope
identity and passes Runtime validation. Otherwise Runtime reports a structured
failure or remains recovery-blocked according to ADR-0023 and ADR-0026. The A2A
transport must not run its own recovery loop, fallback policy or late-result
publication path.

### 6. Artifact Provenance

Remote artifacts are untrusted until Runtime validates and records them through
the existing completion, workspace and publication gates. A future A2A transport
may carry artifact references, manifests and bytes, but it may not publish them,
rewrite completion facts, or merge them into the Task workspace directly.

Every accepted remote artifact reference must preserve provenance that includes:

- producing `attemptId` and `generationId`;
- `configurationRevision` and `bindingFingerprint`;
- remote endpoint identity and transport kind;
- content digest and immutable remote object reference, when the object is not
  inlined;
- declared target path or logical artifact key;
- the artifact policy from the authorized envelope;
- retrieval and validation status recorded by Runtime.

Artifacts from a different attempt, stale configuration revision, mismatched
binding, missing digest, untrusted endpoint or path outside the authorized
workspace/target boundary fail closed. Artifact transport cannot grant new read,
write, network or external-effect authority.

### 7. Permission And Resource Boundary

Permission profiles, partition/resource leases and capability grants remain
Kernel/Resource/Runtime facts. The A2A adapter receives only the attempt-scoped
grants in the envelope and must forward or enforce them without widening,
coalescing or translating them into broader remote authority.

If a remote Executor needs more access, it must submit a structured capability
request back through the Runtime/Kernel permission path. It cannot prompt the
user directly, ask Planner to revise authority out of band, call Storage, inspect
unrelated workspace state, or mint its own grant. Grant use remains
attempt-bound, budgeted and auditable under ADR-0024.

Runtime remains responsible for context materialization, workspace checkpointing,
resource lease lifecycle, artifact intake, completion validation and normalized
observations. The remote endpoint is an execution target, not a new resource
owner.

### 8. Module Dependency Prohibitions

Future A2A code must obey ADR-0020 and these narrower prohibitions:

- `planning/` and Planner processes may not import, configure or call A2A
  transport code.
- `kernel/` may not depend on A2A types, remote discovery, transport clients,
  sockets, HTTP/RPC libraries, remote job IDs or artifact stores.
- A2A adapters may not depend on Planning implementations, Session, TUI,
  Gateway, Commands, concrete Storage repositories or Kernel internals.
- Session, Gateway, Commands and TUI may not bypass Runtime to submit A2A jobs,
  cancel attempts, fetch artifacts or write remote status.
- Storage tables and remote protocol schemas may not become cross-module domain
  interfaces.
- No transport-specific scheduler, router, retry engine, recovery workflow,
  health policy, capacity policy or permission policy may be introduced.

Only the composition root may wire a concrete A2A adapter into the
`ExecutorAdapter` port after a future roadmap approves that implementation.

### 9. Current Release Boundary

This release must not add a production A2A adapter, inactive A2A configuration
variant, remote endpoint registry, dynamic discovery, authentication flow,
streaming protocol, cancel protocol or artifact transport. It may only keep the
ExecutorAdapter authorized-attempt port transport-neutral and ensure the
identity, grant and provenance facts needed by a future transport are available
at that seam.

Before A2A can ship, a separate future roadmap must cover version negotiation,
trust rotation, endpoint registration, request idempotency, disconnect handling,
poll/stream/cancel semantics, uncertain outcomes, artifact integrity, remote
permission/resource boundaries, failure normalization and acceptance tests.

## Consequences

A2A can later add remote execution without changing Planner semantics, Kernel
authority or Runtime recovery. Transport uncertainty remains an observable fact,
not a hidden reason for another scheduling or retry policy. The authorized
attempt envelope becomes the compatibility seam for local CLI, container and
future remote transports.

The current release remains intentionally smaller: it proves transport neutrality
at the ExecutorAdapter boundary and defers all A2A protocol and operational
choices until the remote Executor roadmap is approved.

## Not Decided Here

- A2A wire protocol, endpoint registry, service discovery or version negotiation;
- concrete transport authentication, key rotation and trust-root distribution;
- remote sandboxing, hosting, queueing or operational SLAs;
- artifact store implementation or remote byte-transfer protocol;
- dynamic remote capability discovery;
- any multi-top-level-Task scheduling, priority, fairness or preemption policy.
