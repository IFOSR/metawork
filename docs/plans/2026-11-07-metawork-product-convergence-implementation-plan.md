# MetaWork Product And Architecture Convergence Plan

- Plan date: 2026-11-07
- Status: Phase 0 baseline closed, Phase 1 contracts accepted (ADR-0055, owner waiver); Phase 2+ proceeding by the [reset implementation plan](2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md)
- Requirements: [MetaWork Product Requirements](2026-11-07-metawork-product-requirements.md)
- Scope: one integrated sequence for the product changes and repository cleanup in the requirements
- Local implementation update (2026-11-08): [continuation and verification record](2026-11-08-metawork-convergence-continuation-record.md). This 2026-11-08 checkpoint is historical: the 2026-11-10 D6 batch removes the Kernel ledger and wires production Router dispatch. Review R-01–R-28 and the continuation record define current behavior and remaining acceptance gaps. No commit or push before the user's local review.

## Goal

Deliver the product described by the requirements while removing retired runtime,
compatibility, deployment, and documentation paths in dependency order. Each
implementation batch must have a reviewable inventory, an owning contract, a
focused verification set, and a clean rollback point.

## Confirmed Product Decisions

- There is no Kernel layer. Router uses a decision model and directly dispatches
  each Subtask to an Agent and model. Dispatch does not wait for a second approval.
- Manager understands and decomposes user intent, summarizes completed work,
  and handles Executor permission requests. Manager decides when it has enough
  context; otherwise it asks the user. Platform isolation and cross-account
  boundaries remain enforceable and cannot be widened by a model decision.
- Remove compatibility behavior and old-data upgrade paths. The product uses a
  fresh database contract; old local databases are not migrated.
- Model usage is Token usage only. The system records complete usage and has no
  amount-confirmation state. Model prices and model-cost accounting are removed.
- A running Task continues to block new input until it completes. Mid-execution
  input classification, task revision, and interruption are deferred; the
  requirements' AC-35 through AC-37 are not part of this delivery.
- Deployment topology is outside this plan. Server must support configured
  listener addresses, authenticated remote access, configurable allowed origins,
  and loopback-only internal services.
- Keep Web, macOS Apple Silicon Desktop, and Feishu as the product clients;
  remove the terminal client surface. Linux remains a supported Server target.
- Manager and Executor use the same bundled upstream Pi Agent version. The
  user's global Pi installation is neither read nor used. Codex is removed as
  an Executor path.

## Planning Boundaries

- This plan removes model price/cost and per-Task model billing. It does not
  assume that commercial account licensing or subscription payments are removed;
  those are separate from model usage and must be inventoried against the
  subscription requirements before deletion.
- The requirements explicitly leave quota tier values, the quota baseline,
  memory export format, Router failure fallback, permission red lines, and
  partial-result behavior open. The architecture phase must settle items that
  affect ownership or persisted contracts. Product values and export details
  can remain release configuration or later UX decisions where they do not
  block implementation.
- Removing Kernel does not remove durable Task, Attempt, permission, workspace,
  result, or recovery facts. The architecture phase assigns their owners and
  replacement transitions before Kernel code and schema are deleted.
- The full repository audit must distinguish product/runtime compatibility
  paths from attributed upstream code, current persistence facts, and historical
  records needed to explain superseded decisions. Preserve the upstream identity
  `AnyFusion-Pi` and internal compatibility identifiers unless a dedicated
  decision says otherwise.

## Integrated Sequence

Cleanup is integrated into the dependent product batches: each retired path is
removed as soon as its replacement passes its gate. Phase 6 covers only the
remaining cross-cutting assets that have no earlier owning feature phase; it is
not a separate cleanup-first or cleanup-last project.

### 0. Baseline And Repository Audit

Inventory every source module, test group, schema/table, configuration surface,
build/release script, deployment asset, active document category, and archived
plan category. For each proposed removal, record its production references,
replacement (if any), affected persisted facts, and independent verification.
Capture baseline lint, build, and test results on macOS arm64 + Web; D14 defers Linux and the other clients.

**Exit gate:** the audit report covers the whole repository and identifies the
minimal set of product-critical paths that must survive the cleanup. No code is
deleted in this batch.

**Status 2026-11-07:** audit and baseline repair delivered as batch B0.2 (see the
[B0.2 failure record](2026-11-07-b0-2-baseline-failure-classification-record.md)).
`npm test` moved from `53 failed / 4553 passed` (18 files) to
`44 failed / 4562 passed` (14 files), and then to a green root suite after each of
the 44 cases was resolved as either a production defect fix or a contract change
with ADR basis. The independent
[retrospective review](2026-11-07-metawork-product-convergence-retrospective-report.md)
then confirmed three defects in the first repair round (read-only admission
executed as a write, acceptance rejection from a post-seal snapshot comparison,
and directory-intent syntax drift); all three are fixed with regression tests.
`tests/session/planning-kernel-path.test.ts` needs a ≥2 minute budget (measured
125.8 s, later 23 passed).

Phase 0 exit is still **not** met: the review's target matrix (Kernel, vendored
Pi, Codex, model-cost accounting, TUI, Docker execution, migration chain,
non-loopback Server) shows Phase 2–6 capabilities are not delivered, and the
review requires the per-AC verification evidence. Phase 3 deletion and Phase 6
schema cleanup stay blocked.

### 1. Target Architecture And Contract Reset

Target contracts: [technical implementation plan](2026-11-07-metawork-product-convergence-technical-implementation-plan.md)
§4/§6 and [ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md).
The earlier audit report, contract design and reset implementation documents are
**not present in this workspace**; they must be restored or re-reviewed before
this gate can claim a signed cross-review.

Write the replacement architecture decisions before changing runtime ownership.
Define the public contracts and dependency direction for Manager, Router,
Executor, Task Runtime, persistence, permission decisions, and client
projections. Specify which component owns Task admission, Subtask lifecycle,
retry/fallback, cancellation, completion validation, publication, and recovery
after Kernel removal. Specify the Manager permission decision boundary and the
user-escalation path. Confirm Router failure behavior and how partial work is
reported.

Supersede the ADRs and current docs that describe Kernel as the sole strategic
authority. Keep a compact decision history and update the ADR index, `CONTEXT.md`,
and technical overview to the approved target.

**Exit gate:** every strategic and security-sensitive action has one owner;
there is no second policy interpreter or hidden Kernel compatibility path.

**Status 2026-11-07:** gate **closed by product-owner decision** (cross-review
waived, not signed). [ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)
is Accepted and its Decision ledger settles P-1..P-4 policy defaults (retry scope,
permission catalogue, partial success, auditable non-deterministic routing), plus
Pi packaging, MetaWork-only naming, Kernel/legacy-data removal, network/isolation
boundaries and the macOS+Web acceptance scope. The implementable contracts live in
the [target contract design](2026-11-07-metawork-target-architecture-contract-design.md);
batches proceed in the [reset implementation plan](2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md).

### 2. Single Upstream Pi Runtime And Executor Convergence

Replace the vendored private Agent runtime with the pinned upstream Pi package
and platform-owned extensions. Use the same Pi version and packaging contract
for Manager and Executor. Prove clean-install operation without a system Pi
installation. Remove Codex discovery, configuration, execution, permissions,
tests, packaged assets, and product UI after the Pi path covers their supported
workflows. Keep non-Agent specialized capabilities only where the requirements
still require them and the audit proves they are not a second general Executor.

**Exit gate:** clean-machine planning and execution use the bundled Pi runtime;
user-installed Pi and Codex are not consulted; Manager's read-only boundaries
are tested outside Pi prompt behavior.

### 3. Direct Router Dispatch And Kernel Removal

Implement Router's per-Subtask Agent/model decision and direct dispatch through
the contracts from Phase 1. Persist enough route identity and rationale to
explain the decision in the trace. Move Task lifecycle, recovery, retry,
completion, cancellation, and publication behavior to their designated owners.
Implement Manager-mediated Executor permission handling, including direct
decisions and user escalation when Manager lacks sufficient context.

Once replacement paths pass their owner-level tests, remove Kernel policy,
decision ledger/workflow, Kernel-specific events and projections, associated
configuration, and all callers. Preserve durable operational facts and
idempotency where the replacement runtime needs them; do not preserve Kernel
compatibility APIs or historical Kernel data readers.

**Exit gate:** no production or test dependency on Kernel remains; Router
dispatches directly; permission grants are Manager-authorized and still obey
platform isolation boundaries; restart/recovery and completion acceptance pass
end-to-end tests.

### 4. Token Usage, Quotas, And Accounted Product Flows

Replace model-cost billing with complete per-call Token usage facts, including
the source, Provider, model, payer category, and event time required for exact
aggregation. Remove model price catalogs, currency conversion, cost entries,
per-Task bills, amount uncertainty, and external model-cost settlement paths.
Implement Included versus user-owned Provider usage, quota windows, exhaustion
guidance, and the usage query contract. Keep subscription/account payment code
only if the audit confirms it is product licensing rather than model-cost
settlement; do not retain model prices under a different name.

**Exit gate:** every supported model call has an authoritative Token usage
record; aggregates reconcile to those records in Beijing time; no model price,
amount, or amount-confirmation state remains in runtime, storage, or clients.

### 5. Client Product Surfaces And Server Addressing

Move usage and memory into their dedicated client views, add bounded memory
search/filter/pagination/export, and align supported task, permission, trace,
and usage flows across Web, Desktop, and Feishu. Remove the terminal client
entry points and make the bare CLI open Web while retaining Server management
commands. Restrict Desktop artifacts to macOS Apple Silicon and remove Windows
and other unsupported desktop release outputs; D13 retains Windows code as unmaintained. Add configurable Server binding and allowed
origins without weakening authentication; internal services stay on loopback.

**Exit gate:** only the three specified clients are user entry points; supported
capabilities work across them; remote Server access is authenticated and origin
checked; Desktop release output is Apple Silicon only.

### 6. Remaining Cross-Cutting Cleanup

Apply the Phase 0 inventory to residual assets not already removed alongside
their replacement. Remove Dockerfiles, images, build scripts, Docker execution
backends, container permissions/reconciliation, and Docker tests after the
maintained macOS native execution path is verified (D12/D14). Retain Windows
runtime/installer code as unmaintained and stop publishing Windows updates (D13).
Keep native process reconciliation and permission hard-deny rules under their
owners; their retained container vocabulary does not establish Docker execution.
Replace the schema migration chain with the approved fresh schema and delete
old-schema readers, compatibility parsers, and retired event formats as their
new owning persistence contracts land. Archive completed plans and superseded
ADRs; update or delete stale current docs. Remove dead code and abstractions
discovered by the audit, not only the known targets.

Each batch records its exact deletion list, rationale, replacement or explicit
absence, focused tests, full supported-host test result, and rollback commit.

**Exit gate:** no local Docker execution/test assets remain (official-server
deployment is independent); Windows is declared unmaintained; fresh databases use only the new schema; no old database/config/
protocol compatibility branch remains; `docs/plans/` contains no completed
active plans and current docs match the delivered architecture.

### 7. Release Acceptance And Closeout

Run the complete lint, build, and test suite on macOS arm64 and verify Web
without Docker. D14 defers Linux, Desktop and Feishu acceptance.
Run clean-install acceptance for bundled Pi, a real Manager-to-Router-to-
Executor task, permission escalation, result publication, Token usage
reconciliation, quota exhaustion, memory export, Web, and
non-loopback authenticated Server access. Update this plan with completion
date, delivered behavior, validation evidence, and closing commit; update the
docs index and current architecture docs.

**Exit gate:** all PRD acceptance criteria in scope pass; deferred criteria are
explicitly recorded and do not rely on removed compatibility paths.

## Cross-Batch Rules

- Every batch has one owner boundary and can be reviewed and reverted
  independently. No batch deletes a production path before its replacement
  passes the relevant gate.
- Run focused tests for the owning seam plus lint/build and the full supported
  host test suite after each deletion batch, as required by the PRD.
- Persistence changes update repositories, fresh-schema fixtures, and affected
  Docker-independent tests together.
- Keep server-side authentication, account isolation, permission auditability,
  immutable result identity, and workspace publication guarantees unless an
  accepted replacement contract explicitly supersedes them.
- Do not implement execution-time interruption or direction-change behavior in
  this plan. The current single-active-Task input blocking behavior remains.

## Deferred Decisions

- Numeric quota tiers, quota baseline, and subscription/environment price points.
- Router failure retry/fallback policy and the user-visible partial-result
  policy, to be settled in Phase 1 before their runtime implementation.
- Exact permission red lines, to be settled in Phase 1 with security ownership.
- Memory export format and range.
- Cloud hosting, per-user environment provisioning, and deployment/update
  infrastructure. This plan covers Server address binding and client access
  only.
- Mid-execution user input, task revision, and Attempt interruption.

