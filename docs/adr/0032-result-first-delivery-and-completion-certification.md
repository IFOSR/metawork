# ADR-0032: Result-First Delivery And Completion Certification

- Status: Accepted
- Date: 2026-08-21
- Scope: Executor result delivery, completion metadata, Result Object persistence, authorized handoff references, and partial-result recovery
- Amends: ADR-0021, ADR-0022
- Governed by: ADR-0020

## Context

The current Completion Protocol treats a model-facing trailer, evidence limits,
handoff budgets, and workspace facts as one blocking gate. A Harness can finish
the business work while MetaWork rejects the response as `contract_blocked`.
That reverses the product boundary: MetaWork should enhance Harness selection,
authorization, coordination, observation, recovery and delivery, not reduce the
capability of the selected Harness.

## Decision

MetaWork evaluates every Executor outcome on three independent axes:

1. `resultDeliverability`: whether a safe user-facing result exists.
2. `completionAuthority`: whether Runtime facts are sufficient to certify the
   Subtask, publish authorized handoffs and release downstream work.
3. `safetyDisposition`: whether the result or workspace violates a security or
   authorization boundary.

A safe business result is delivered even when completion metadata is malformed,
missing or incomplete. Such a result is marked `partial` and `uncertified`;
it cannot move a Subtask to `done` or release downstream dependencies until the
Kernel receives sufficient facts. An uncertified result is not a second routing
system. `ControlKernel` remains the only owner of recovery, retry, replan,
manual acceptance, downstream release and final completion.

Completion Protocol v4 is the active protocol for new attempts. It permits a
body-only response and treats the trailer as certification metadata. Runtime
may deterministically normalize evidence and protocol metadata. If normalization
is not safe, it records `audit_metadata_incomplete` while retaining the business
result. Completed v3 receipts are immutable historical facts and are not
re-executed or dual-read as a new production protocol.

The following are not business-result rejection rules:

- answer length, source count, evidence count, ordinary execution duration;
- normal Executor reasoning depth or legal tool calls;
- marker/trailer presence, metadata shape or metadata frame size;
- one-frame limits of Gateway, JSONL, WebSocket or SQLite.

Physical limits remain valid as infrastructure boundaries. Runtime uses
streaming, immutable objects, chunking, references and `partial/incomplete`
states. It never silently truncates a result or converts a transport limit into
an invalid business result.

File delivery is separate from text delivery. An uncertain workspace delta may
hold file publication and file handoff, but must not suppress an independently
safe text result. Ordinary Workspace and user-space file writes are not unsafe
merely because a Subtask uses `report` delivery. System-control access,
credential exposure, privilege changes, device or Docker control-plane access,
unsafe internal data, and unauthorized ResultReference access remain
fail-closed.

## Result Objects And Handoffs

Runtime persists immutable `ResultObject` records for raw attempt output,
business result and safe delivery projection. Attempt receipts store references
and the structured assessment, not duplicated large bodies. Raw output is
restricted to audit/recovery access and is never exposed through ordinary
Gateway events.

An outgoing dependency receives a Runtime-owned `ResultReference` bound to the
Account, Task, generation, source Subtask, target Subtask and authorized edge.
The downstream Executor receives an edge-scoped summary and read capability;
full content is fetched only through the authorized reference. The model never
chooses internal Subtask identities or edges.

Gateway delivery uses snapshot/chunk/completed events with offset replay and
content-hash verification. Delivery events are presentation facts and cannot
mutate Task, Subtask, handoff or Executor state.

## Kernel Contract

Runtime emits a normalized `execution_result_observed` fact containing Result
Object references, assessment, workspace facts and attempt identity. Kernel
decides the existing completion, recovery, hold or retry action from that fact.
The Gateway may emit `result_delivery_available` before final certification,
with an explicit `uncertified` status, and startup recovery must replay the same
delivery idempotently.

Response-only correction is best-effort metadata repair only. It never changes
the business body, repeats the business task, or becomes a permanent blocking
gate. If correction fails, the result remains deliverable when safe and the
Subtask remains under ordinary Kernel decision/recovery handling.

## Persistence And Migration

The implementation introduces the Result Object and reference persistence
contract in SQLite schema v32, with immutable account-scoped object storage.
The 31-to-32 migration preserves all existing receipts, Kernel ledger entries
and contract-failure events. Historical `contract_blocked` records may be
upgraded idempotently when a safe body can be deterministically extracted; an
upgrade never marks the historical body as certified or blindly re-executes the
Harness.

## Consequences

- Users receive safe Harness results instead of losing them to metadata errors.
- Completion certification and downstream release remain auditable and
  fail-closed where they matter.
- Result storage, chunked delivery, migration and retention add implementation
  complexity.
- Existing strict completion tests and contract-blocked behavior must be
  replaced with v4 assessment and result-first tests.
