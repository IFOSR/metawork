# MetaWork Product Identity Migration Design

**Status:** Approved

**Plan date:** 2026-08-26

**Goal:** Make MetaWork the canonical product identity of this repository while
preserving AnyFusion-derived components, existing installations, runtime state,
and compatibility entry points.

## Product Boundary

MetaWork is the proprietary commercial system delivered from this repository.
All current user-facing product introductions, installation guidance, command
examples, UI copy, package metadata, operational documentation, and release
language must present MetaWork as the product.

AnyFusion is a separate open-source software project. MetaWork may reuse or
embed AnyFusion logic and components, but those references must be presented as
upstream/component attribution rather than as the identity of this repository.
Names that identify a concrete component or compatibility contract remain
unchanged where renaming would be inaccurate or disruptive, including:

- the vendored `planner/AnyFusion-Pi` component;
- AnyFusion-derived implementation types that still describe that component;
- existing `anyfusion` commands and `ANYFUSION_*` settings during the
  compatibility period;
- historical AnyFusion release and design records;
- `MetaClaw`, `metaclaw`, and `Metaclaw*` internal/runtime compatibility names.

## Canonical And Compatibility Names

| Surface | Canonical MetaWork identity | Compatibility behavior |
| --- | --- | --- |
| Product name | MetaWork | AnyFusion appears only for attributed components, upstream logic, compatibility, or history |
| npm package | `metawork` with `"private": true` | Do not publish the former `anyfusion` package from this repository |
| Primary CLI | `metawork` | Keep `anyfusion` and `metaclaw` aliases |
| Install root | `~/.metawork` | Migrate an existing `~/.anyfusion` installation once |
| Environment | `METAWORK_*` | Accept corresponding `ANYFUSION_*` aliases |
| Current docs and UI | MetaWork | Preserve literal component, path, protocol, and historical names when required |

Public documentation promotes only the canonical MetaWork names. Compatibility
names remain documented in a bounded migration section and command help where
operators need them.

## Compatibility Rules

### CLI

The installed launcher and `package.json` expose `metawork` as the primary
command. Existing `anyfusion` and `metaclaw` commands continue to invoke the
same composition root. Command aliases do not create separate runtimes,
configuration authorities, or databases.

### Environment

Every renamed public environment setting has one canonical `METAWORK_*` name
and, where already supported, one `ANYFUSION_*` alias. Resolution follows these
rules:

1. use the MetaWork variable when only it is set;
2. use the AnyFusion variable when only the compatibility variable is set;
3. accept both when they normalize to the same value;
4. fail closed with a field-specific diagnostic when both are set differently.

Environment compatibility is resolved at the existing configuration/application
boundary. Core Planning, Kernel, Work Graph, Task, and Execution modules do not
gain product-name branching.

### Installation State

Fresh installations use `~/.metawork`. An existing `~/.anyfusion` installation
is migrated once rather than read and written in parallel:

1. acquire the existing physical runtime/update lock;
2. refuse migration while the Server cannot prove admission closure and
   dispatch drain;
3. copy the installation into a staging MetaWork root without mutating the
   source;
4. verify configuration, secrets metadata, database, generated runtime,
   Planner sessions, Conversations, workspaces, attempts, results, and release
   pointers;
5. atomically activate the MetaWork root;
6. retain the old root as a rollback archive that is no longer a write
   authority.

If validation or activation fails, the AnyFusion root remains authoritative.
Runtime code must never introduce steady-state dual-read or dual-write
behavior.

Existing explicit path overrides remain authoritative. Migration applies only
to the default installation root unless the operator explicitly requests a
different target.

### Source Compatibility

New public installation/path APIs use MetaWork names. Existing exported
AnyFusion-named helpers may remain as thin forwarding aliases until callers and
tests migrate. They must not contain independent resolution or migration logic.

Internal symbols are renamed only when they represent the MetaWork product
rather than a concrete AnyFusion component. This avoids a broad cosmetic
refactor that could destabilize Planner, Kernel, Runtime, storage, or protocol
contracts.

## Documentation And Release Policy

The following current authorities move to MetaWork:

- `AGENTS.md`;
- English and Chinese repository READMEs;
- `CONTEXT.md` product framing;
- current technical overviews and documentation index;
- current CHANGELOG and package metadata;
- current UI, help, installer, doctor, status, and operational messages.

Historical AnyFusion releases, archived plans, accepted records describing an
actual AnyFusion component, and literal compatibility identifiers are not
rewritten. Current documentation may link to them with an explicit historical
or component label.

The previous 2026-08-26 AnyFusion README refresh remains in Git history as an
incorrect product-assumption record. This migration supersedes its public
identity decision without rewriting its completed audit text.

## Licensing Boundary

The repository is treated as a private MetaWork package and must not advertise
itself as an open-source AnyFusion release. `package.json` is marked private and
public release/publishing claims are removed.

The root proprietary license text is not invented during this engineering
change. Company-approved terms must be supplied separately. Existing
AnyFusion-derived and other third-party notices must remain attributable and
must not be removed by the branding migration.

## Ownership And Dependency Direction

This migration is an Application Shell, installation, configuration, and
documentation concern. It does not alter ADR-0020 ownership:

- Planning still proposes;
- ControlKernel still decides;
- Runtime still applies authorized side effects;
- storage remains the durable adapter;
- UI, CLI, Gateway, and installers remain peripheral surfaces.

No product-name resolver may become a semantic router, Kernel policy, Runtime
recovery branch, or storage dual-authority path.

## Validation

Implementation must add or update focused tests for:

- `metawork`, `anyfusion`, and `metaclaw` reaching the same composition root;
- MetaWork and compatibility environment-variable precedence and conflicts;
- clean-install `~/.metawork` layout;
- successful one-time migration from `~/.anyfusion`;
- failed migration preserving the original authority;
- database, configuration revision, secret references, Planner sessions,
  Conversations, workspaces, attempts, results, and release pointer retention;
- installer/update/rollback locking and idempotency;
- current public surfaces containing MetaWork rather than accidental AnyFusion
  product claims;
- retained `AnyFusion-Pi` and other required component attribution.

Required gates are focused Vitest suites, `npm run lint`, `npm run build`,
shell syntax checks, Web build/tests, and the Docker/POSIX test path for
SQLite and filesystem migration behavior.

## Delivery Sequence

1. Establish canonical product constants and compatibility resolution tests.
2. Add the `metawork` CLI/package facade while retaining aliases.
3. Add the MetaWork install root and transactional legacy-root migration.
4. Migrate current application messages, UI, docs, and release metadata.
5. Run focused migration tests and full repository validation.
6. Record delivered behavior, validation evidence, completion date, and
   closing commit in the implementation plan.
