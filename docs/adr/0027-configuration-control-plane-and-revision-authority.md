# ADR-0027: Configuration Control Plane And Revision Authority

- **Status**: Accepted
- **Date**: 2026-08-11
- **Scope**: Static AnyFusion server configuration, immutable revisions, active configuration ownership, and Planner/Kernel/Runtime configuration binding
- **Amends**: ADR-0018 at the explicit configuration-authority cutover
- **Governed by**: ADR-0020

## Context

Static server configuration is currently represented by multiple files, environment variables, built-in catalogs, Runtime allowlists, and persisted AgentClass rows. Those representations can drift and can cause Planner, Kernel, and Runtime to interpret different definitions during one execution lifecycle.

The server upgrade requires one configuration authority without changing the control axis established by ADR-0020:

```text
Planner proposes
  -> Kernel decides
  -> Runtime applies
  -> Executor executes
```

Configuration must supply immutable facts to that axis. It must not become a semantic router, authorization layer, scheduler, or Runtime policy owner.

## Decision

### 1. One Configuration Control Plane

The authoritative static configuration flow is:

```text
~/.anyfusion/config/active/config.yaml
  -> ConfigurationService
  -> immutable ConfigurationSnapshot
  -> Planner / Kernel / Runtime projections
```

`ConfigurationService` is the only facade allowed to create, validate, compile, activate, roll back, or read authoritative static configuration. Installer, Admin CLI, Gateway management endpoints, and other Application Shell entry points must call this facade. They must not write YAML, generated Harness files, environment files, or SQLite configuration rows directly.

The active path resolves through one active pointer to one immutable revision directory. Generated Planner and Executor configuration, catalogs, and Runtime homes are reproducible projection artifacts of that revision; they are not additional configuration authorities. Secrets remain outside configuration revisions and enter only Runtime-private bindings through references.

SQLite may retain configuration revision audit and dynamic runtime facts, but it must not become a second writable static configuration source. Replacing the file-backed authority requires a superseding ADR.

### 2. Immutable Revision And Active Pointer Ownership

Every validated activation creates a new immutable revision with a stable `revisionId` and content hash. Published revision content and its compiled projections must never be modified in place.

`ConfigurationService` exclusively owns activation and the active pointer:

- the single active pointer is the only switch that makes a revision active;
- activation replaces that pointer atomically after the complete revision and projections are durable;
- rollback creates a new revision that reproduces previously accepted content, rather than mutating or reactivating historical files in place;
- a missing, hash-mismatched, or incomplete active revision is recovery-blocked and must not be guessed or silently replaced;
- a revision referenced by a Planner run, Work Graph generation, Kernel decision, deferred replan, dispatch, attempt, or receipt cannot be mutated or garbage-collected.

Configuration activation changes static inputs for future bindings. Immediate operational denial of work is a separate durable Kernel input; it must not rewrite a historical configuration revision.

### 3. One Revision Per Work Graph Generation

Each Work Graph generation binds exactly one configuration revision when that generation is created. The proposal, every graph revision within the generation, Kernel admission and decisions, deferred replans and recovery, dispatches, retries, fallbacks, attempts, Runtime bindings, and receipts remain pinned to that same revision.

Changing the active pointer does not affect an existing generation. New attempts or recovery for that generation continue to resolve the pinned revision. To use a newer active revision, the Application Shell must request the existing Kernel-controlled replan path that creates a new generation; no consumer may silently refresh configuration inside an existing generation.

Durable facts at these seams must carry the configuration revision identifier so restart and recovery reproduce the original projections rather than reading the then-current active revision.

### 4. No Dual Read Or Dual Write

Migration to this control plane uses one explicit cutover:

- before cutover, the current runtime authority remains unchanged while new revisioned consumers are prepared;
- migration readers may create a candidate revision, but they cannot keep legacy sources synchronized;
- at cutover, all Planner, Kernel, Runtime, Installer, Admin, and Gateway consumers switch to the Configuration Service projections together;
- after cutover, legacy catalogs, environment files, SQLite rows, allowlists, and generated Harness files cannot be fallback reads or parallel write targets.

There is no compatibility mode that reads both legacy and revisioned configuration, chooses whichever is present, or writes both representations. Failed validation or activation leaves the prior active pointer unchanged and fails closed.

### 5. Dependency Direction

The allowed dependency direction extends ADR-0020 as follows:

```text
Application Shell -> ConfigurationService
Planning          -> PlannerConfigurationView
Control Kernel    -> KernelConfigurationView
Execution Runtime -> RuntimePrivateConfigurationBinding
```

The Configuration module owns configuration contracts, validation/compilation orchestration, revision lifecycle, and projection construction. It must not import Control Kernel policy or Execution Runtime implementations. Planning must not import Runtime-private bindings. Control Kernel may consume its immutable view as explicit decision input, but it must not import a concrete configuration repository or read the active pointer. Execution Runtime may consume only the exact Kernel-authorized private binding for the pinned revision.

Concrete file, secret, audit, and persistence adapters remain outside core policy and are wired at the composition root. Gateway, Commands, TUI, and other Application Shell surfaces must not bypass the Configuration Service to import Storage adapters.

## Consequences

- Planner, Kernel, Runtime, recovery, and audit facts can reproduce one coherent configuration interpretation for a generation.
- Configuration changes become atomic for new generations and cannot alter in-flight retry, fallback, or recovery behavior.
- Historical revisions consume storage while referenced, but retain exact audit and recovery semantics.
- Administrative configuration and immediate operational control remain separate, preventing configuration activation from bypassing Kernel authority.
- The initial `src/configuration/index.ts` exposes type-only placeholder ports. Concrete schema, projections, persistence, activation, and migration behavior are delivered by later implementation tasks without relaxing this ADR.

## Not Decided Here

- The complete configuration schema and AgentClass, Harness, Provider, Model, and Permission Profile shapes.
- Concrete file layout, activation journal representation, secret-store adapter, or revision garbage-collection algorithm.
- Provider/Model health policy, Executor transport details, and release upgrade trust.
