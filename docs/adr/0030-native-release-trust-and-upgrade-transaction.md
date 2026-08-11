# ADR-0030: Native Release Trust And Upgrade Transaction

- **Status**: Accepted
- **Date**: 2026-08-11
- **Scope**: Native AnyFusion release verification, local upgrade transaction, SQLite migration safety, activation, rollback and crash recovery
- **Governed by**: ADR-0020
- **Preserves**: ADR-0011, ADR-0015, ADR-0020, ADR-0023, ADR-0024, ADR-0025 and ADR-0026

## Context

Native AnyFusion installation and upgrade must eventually replace the MetaClaw
runtime image, bundled Planner artifact, static assets, CLI entrypoints and
SQLite schema while preserving the single active Task boundary and all durable
workflow invariants. A local upgrade is riskier than an image rebuild because it
can overlap with a live Planner session, active Executor attempts, open SQLite
WAL files, pending dispatch/publication rows and user-facing entrypoints.

The product must fail closed when a release cannot be authenticated, when the
database cannot be proven restorable, when active work has not quiesced, or when
a candidate build cannot prove compatibility before activation. It must not
produce a state where one process reads runtime code from one version while
another process reads migrated storage or Planner artifacts from another
version.

## Decision

Native upgrade is one serialized, auditable transaction owned by the native
installer/upgrader application path. The transaction may coordinate with
Session, Runtime and Storage ports, but it does not move policy authority into
Planner, Executor adapters, the TUI or the pure Control Kernel.

The only successful end state is one manifest-approved compatibility combination
of application release, database schema/data, active configuration revision, and
revision-scoped generated runtime. The only failed end state restores or retains
the previous verified application/data/configuration content combination.
Configuration rollback may use a new immutable revision identity as required by
ADR-0027. These are independent versioned objects coordinated by one activation
journal; mixed combinations are not supported, not auto-repaired by dual reads,
and not exposed to ordinary startup.

## Release Trust

Native releases are accepted only through a signed release manifest. Artifact
hashes, sizes, executable entrypoints, bundled Planner build identity, target
SQLite schema, supported source schema range, candidate configuration
schema, generated-runtime compiler/template identity, migration plan identity,
post-activation health checks, rollback metadata and keyring epoch are all
manifest facts. The concrete user configuration revision and generated hashes
are transaction-journal facts validated against those manifest constraints.
Artifacts outside the manifest are ignored.

The trust root is a small pinned public-key bundle shipped with the installed
upgrader. It is not discovered from the network, package metadata, DNS, GitHub,
or a previously downloaded artifact. The updater verifies the manifest before
fetching or staging executable content and verifies every staged artifact by
both manifest hash and signature before it can enter the candidate directory.

Release signing uses delegated online release keys rooted in the pinned trust
bundle. A release key is usable only when it is listed in the newest trusted
root-signed keyring epoch available to the installed updater, is valid for the
manifest's release channel and time window, and is not revoked. Unknown,
expired, channel-mismatched or revoked keys fail closed.

Key rotation is explicit and overlap-based:

1. A trusted root key signs a keyring epoch that adds the next release key while
   the current release key remains valid.
2. At least one release accepted by both old and new release keys is published
   before the old release key is retired.
3. Retirement or compromise is represented by a root-signed revocation entry
   that carries key ID, scope, effective release sequence and reason.
4. The updater persists the highest trusted keyring epoch and revocation epoch
   it has accepted, and it refuses manifests that require downgrading either
   epoch unless an explicit root-signed emergency recovery package authorizes
   that downgrade.

Revocation is checked before artifact download, before staging activation and
during crash recovery. A previously staged but not yet activated candidate
signed by a now-revoked key is deleted. An already-active version remains
bootable only long enough to run rollback, export diagnostics or install a
newer trusted release; it must not be treated as a valid source for another
ordinary upgrade.

## Transaction Phases

The upgrade transaction has one durable activation journal with a monotonic
phase, candidate release, manifest hash, candidate and previous database
identity, configuration revision, generated-runtime revision, application
pointer, data paths and rollback checkpoints. Each phase is idempotent and may
be retried after process or host crash.

### 1. Acquire Update Lock

The updater obtains an exclusive update lock before reading mutable installation
or data pointers. The lock is host-local, stale-detectable and independent of
the application SQLite database. While held, no second updater, installer,
launcher self-update or background maintenance job may begin.

If another AnyFusion process is running, the updater may ask it to enter the
upgrade protocol. It must not replace files underneath a live runtime without
that runtime acknowledging admission closure and drain state.

### 2. Close Admission

The Application Shell closes user and gateway admission before any migration or
activation work starts. Closing admission means no new top-level Task,
Planner turn, slash command that mutates state, permission resolution, recovery
tick or executor-recovery refresh may be accepted except the upgrade-control
events required to drain and persist status.

This is an Application Shell gate. Planner cannot close admission, Kernel does
not read installer state, and Executor adapters cannot approve an upgrade.

### 3. Dispatch Quiesce

Runtime marks dispatch as quiescing and prevents new WorkUnit claims,
publication drains, merge-repair attempts, recovery takeovers and backend
starts. Already persisted Kernel decisions remain immutable audit facts, but
their unapplied side effects may not begin once the quiesce fence is durable.

Late executor outcomes after the quiesce fence are persisted only if they can be
landed through the normal attempt-terminal transaction without starting new
work. Otherwise they remain fenced diagnostics for startup recovery under the
previous version.

### 4. Drain

The updater waits for every active or uncertain runtime effect to reach a
durable terminal, cancelling, parked or recovery-blocked state that is safe to
restart. This includes Planner process turns, dispatch rows, publication rows,
WorkUnit claims, resource leases, execution-backend processes, pending
capability requests and cancellation cleanup.

Drain is not best-effort process killing. If Runtime cannot prove a safe
terminal or resumable state, the upgrade aborts before migration and leaves the
previous version active.

### 5. WAL Checkpoint And Verified Backup

Storage performs a SQLite WAL checkpoint after drain and before backup. The
backup is created from the checkpointed database by SQLite's backup mechanism or
an equivalently verified consistent snapshot, not by copying an arbitrary live
main database file while WAL state may still be pending.

The updater verifies the backup before proceeding by opening it read-only,
checking SQLite integrity, checking the expected source schema version,
checking required MetaClaw sentinel tables and recording a content hash, size
and creation time in the transaction record. A failed verification aborts the
upgrade and keeps the previous version active.

### 6. Cloned Migration

Migration runs only against a cloned copy derived from the verified backup. The
active database is never migrated in place. The candidate binary owns the target
schema migration code, but it is invoked through the upgrader with explicit
source schema, target schema and manifest migration-plan identity.

The cloned migration must fail closed if the source schema is unsupported,
ambiguous recoverable payloads are found, integrity checks fail, or the result
does not exactly match the target schema declared in the manifest. No runtime
process may open the migrated clone as active data until pointer activation.

### 7. Immutable Staging

The updater expands artifacts into a candidate staging directory addressed by
release version and manifest hash. Staging is immutable after verification:
files are content-checked, permissions are normalized, executable entrypoints
are fixed, and no process runs from the staging directory until all hashes,
signatures, migration output and health prerequisites are sealed.

The staging directory contains the MetaClaw runtime, bundled Planner artifact,
bridge/MCP assets and any native launcher material needed by the manifest. It
must preserve ADR-0015 process isolation: Planner remains a separate process
and does not become linked into MetaClaw.

The same transaction also prepares one immutable configuration revision and all
Planner/Executor generated-runtime projections compiled from that exact
revision. Their hashes and compatibility with the candidate release and migrated
database are sealed in the activation journal before any active pointer changes.

### 8. Candidate Health Check

Before activation, the updater runs the candidate health check declared by the
manifest against the staged runtime and migrated clone while the old version is
still active. The check must verify at least release identity, Node/runtime
baseline, Planner process startup, bridge protocol compatibility, current
SQLite schema, read-only opening of the migrated clone, candidate configuration
schema and hash, generated-runtime hashes and command entrypoint resolution.

The health check is diagnostic and compatibility verification only. It may not
accept user input, start Planner semantic turns, schedule Kernel decisions,
claim WorkUnits, start Executor attempts, publish Git changes, send gateway
messages or mutate the live workspace.

### 9. Pointer Activation

Activation is a short admission-closed critical section coordinated by the
single activation journal. Physical database, configuration, generated-runtime,
and application pointers may require separate atomic replacements, but ordinary
startup may observe only the previous committed combination or the candidate
committed combination. The launcher reads the committed journal and its named
pointers, never a mutable installation directory name.

Activation order is:

1. Persist the candidate database pointer as pending with backup and migration
   provenance.
2. Persist the candidate configuration revision pointer as pending.
3. Persist the candidate generated-runtime revision pointer as pending.
4. Persist the candidate application release pointer as pending.
5. Verify that all pending identities match the manifest-approved compatibility
   combination, then atomically commit that combination in the activation
   journal.
6. Release the admission/drain hold only after the candidate process passes its
   first active startup recovery gate.

If activation cannot prove that database, configuration, generated runtime, and
application release form the same manifest-approved combination, it must not
start the application.

## Rollback

Rollback restores the last known-good database/configuration/generated-runtime/
application combination and never tries to downgrade a migrated active database
in place. The verified pre-upgrade backup is the rollback data source.

Rollback order is:

1. Reacquire the update lock and keep admission closed.
2. Stop or fence any candidate process that may have started.
3. Restore the previous data pointer to the verified backup or retain the
   untouched previous active database if activation had not reached the data
   swap.
4. Ask `ConfigurationService` to create and activate a new immutable rollback
   revision reproducing the previous compatible configuration content; do not
   reactivate or mutate a historical revision directory.
5. Restore the generated-runtime pointer to projections compiled from that
   rollback revision.
6. Restore the previous application release pointer and start the old daemon.
7. Run previous-version startup recovery against the restored combination.
8. Reopen admission only after previous-version recovery proves dispatch,
   publication, leases and backend state are coherent.
9. Retain failed candidate staging and migrated clone only as quarantined
   diagnostics; they must never be selected by ordinary launch.

Rollback may be initiated by failed candidate health check, activation failure,
first-start failure, explicit operator request, or crash recovery detecting an
incomplete transaction. If rollback cannot prove safe state, AnyFusion starts in
recovery-blocked mode with diagnostics and no new Task admission.

## Crash Recovery

Every phase records enough durable metadata for startup to choose exactly one
of three paths: continue the candidate transaction, roll back to the previous
verified combination, or enter recovery-blocked mode. Startup must inspect the
update transaction record before opening ordinary application services.

Crash recovery rules:

- If the lock exists but no transaction record exists, validate current active
  pointers and clear only a proven stale lock.
- If trust verification, staging, backup or cloned migration was incomplete,
  delete incomplete candidate material and retain the previous active
  combination.
- If activation was not marked complete, restore or retain previous pointers
  according to the last durable phase and run previous-version recovery.
- If activation was marked complete but first active startup was not recorded,
  start only the candidate recovery path; on failure, roll back using the
  verified pre-upgrade backup.
- If active database, configuration, generated-runtime, and application
  identities do not match one committed compatibility combination, or reference
  missing paths or unverified hashes, refuse ordinary startup and enter
  recovery-blocked mode.
- If revocation status changed while a transaction was incomplete, re-run trust
  verification before continuing or rolling forward.

Crash recovery must not infer compatibility by attempting dual reads across
schema versions. The selected application, database, configuration revision, and
generated runtime must match one committed activation-journal combination before
any Session, Planner, Kernel, Runtime or Gateway service starts.

## Ownership And Dependency Direction

The native updater is an Application Shell/runtime-adapter concern. It may use
ports exposed by Session, Runtime and Storage to close admission, drain effects,
checkpoint, back up, migrate clones and verify health. It may not introduce a
second planner, semantic router, Kernel policy path, Executor selection path or
storage mutation path.

Ownership is fixed as follows:

| Concern | Owner | Not Owner |
| --- | --- | --- |
| Manifest verification, keyring epochs, revocation checks and artifact staging | Native updater / installer adapter | Planner, Kernel, Executor |
| Admission close and launcher pointer selection | Application Shell | Planner, Executor adapters |
| Dispatch quiesce, drain coordination, backend stop/fence and normalized runtime facts | Execution Runtime | Planner, pure Control Kernel |
| SQLite checkpoint, verified backup and cloned migration execution | Storage adapter through explicit ports | UI, Planner, Executor adapters |
| Strategic Task/Subtask recovery after restart | Control Kernel from explicit snapshots/events | Updater, Planner, Runtime policy glue |
| Candidate health-check orchestration | Native updater using read-only application ports | Planner semantic loop, Executor attempts |

ADR-0020 remains authoritative. Pure Control Kernel does not read updater
transactions, filesystem pointers, manifests, clocks or SQLite handles. Planner
does not authorize upgrade work. Runtime applies only explicit drain, recovery
and storage operations exposed by its ports and does not decide release trust.

## Consequences

- Native upgrade becomes a fail-closed transaction instead of an in-place file
  replacement.
- SQLite migrations are proven on a clone before active pointers change.
- Release authenticity is anchored in pinned keys and root-signed revocation,
  not transport security or package-host trust.
- The system may spend longer in admission-closed drain before upgrading, but
  it avoids corrupting active attempts or publishing mixed-version facts.
- Future implementation must add focused tests for phase idempotence, trust
  failure, revocation, WAL backup verification, cloned migration failure,
  activation crash windows, rollback and no mixed-version startup.

## Not Decided Here

- Concrete signature algorithm, key format, transparency log, release hosting
  provider or package channel naming.
- Native installer UI, auto-update cadence, user prompts and enterprise policy.
- Exact filesystem layout for release roots, data roots, backup retention and
  quarantine cleanup.
- Future multi-top-level-Task scheduling during upgrade windows.
- Implementation of schema versions after SQLite v30.
