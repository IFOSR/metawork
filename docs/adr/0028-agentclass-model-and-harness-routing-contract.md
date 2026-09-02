# ADR-0028: AgentClass, Model, And Harness Routing Contract

- **Status**: Accepted
- **Date**: 2026-08-30
- **Scope**: Harness, Model, AgentClass ownership, generation-scoped authorized execution bindings, revision-scoped health identities, binding-fingerprint attempt history, structured failure subjects, and code-owned permission-profile grammar
- **Amends**: ADR-0017, ADR-0018, ADR-0023, ADR-0024
- **Governed by**: ADR-0020

## Context

ADR-0018 established the static routing catalog and the split between controlled routing facts and dynamic health. ADR-0017 established the bounded AgentClass status projection. ADR-0023 and ADR-0024 established durable workflow recovery, structured failure, resource partitions, and permission-bound execution. What they do not yet define is the precise ownership split between Harness, Model, and AgentClass, the exact identity of an authorized execution binding, or how fallback history and health projections must stay revision-scoped when the same AgentClass can run under different model choices.

Without a single binding contract, a generation could accidentally reuse stale configuration, collapse two model choices into one history entry, or project provider/model health across incompatible revisions. That would make fallback and recovery nondeterministic and would blur the line between code-owned permission grammar and runtime configuration data.

## Decision

### 1. Ownership split

Harness, Model Profile, and AgentClass are separate definitions in one immutable
configuration revision. Code owns their strict schema, controlled vocabularies,
validation rules, and registered Harness driver implementations. Configuration
owns the concrete named records and references; it cannot inject executable
adapter code or create new policy semantics.

- Harness Definition describes how an agent runs: kind, transport, command or
  release reference, registered driver ID, and supported
  probe/abort/continuation mechanisms.
- Model Profile describes what provider/model target may be used: provider
  reference, model ID, region, capability and compatibility metadata.
- AgentClass Definition describes the routable template: harness reference,
  model policy, permission-profile reference, routing capability hints,
  skills/MCP/plugins, runtime defaults, enablement, and rollout metadata.

The three definitions are not synonyms and may not infer one another by name,
directory, or runtime default. One Harness may back multiple AgentClasses. One
AgentClass may choose among multiple Models only through its declared model
policy, but the runtime binding always resolves to one concrete model choice for
one generation.

The model policy contract is:

```ts
type ModelPolicy =
  | { mode: 'fixed'; modelRef: string }
  | {
      mode: 'auto';
      allowedModelRefs: string[];
      defaultModelRef?: string;
      fallback?: { enabled: boolean; order: string[] };
    };
```

`fixed` authorizes only its exact model. `auto` supplies a bounded, deterministic
candidate set and optional order. Planner may propose a preference, but Kernel
validates or resolves the exact tuple from the pinned revision. Runtime and the
Harness driver may not substitute or silently fall back to another model.
For Auto policy, `defaultModelRef` is only a resolver preference. It is not the
final binding and cannot override a mandatory model capability. When a Subtask
requires a model-derived Routing Capability such as `image-generation` or
`image-editing`, Kernel first removes allowed candidates that lack the
corresponding structural Model capability, then resolves one concrete binding.
An ordinary default model is therefore rejected for image work while an
allowed image-capable model remains selectable.

Planner-safe projections may expose only controlled routing facts and health summaries. They do not expose provider secrets, raw runtime commands, or free-form permission rules.

### 1.1 Unified Executor capability profiles

An Executor AgentClass may carry bounded user guidance and normalized semantic
assertions. Configuration compilation derives one independent
`ExecutorCapabilityProfile` per Executor from the AgentClass's effective model
set, structural model evidence, controlled affordances, configured capability
declarations, and user routing dispositions. The profile emits both the
revision-pinned Skill-style manual and the Planner-safe Routing Catalog entry.
The final manual is Planner's authoritative semantic routing profile; the
Catalog is its machine-readable qualification and preference projection.

For an Auto policy, the profile records which allowed Model supplies each
model-derived capability. System-known, Provider-declared, and user-confirmed
registered model facts are distinct evidence classes. User assertions take
precedence over conflicting generated semantic prose and may lower, disable,
allow, or prefer a structurally supported Routing Capability. They cannot
authorize an unconfigured Model, invent capability or permission grammar, or
bypass concrete binding validation.

The profile is not part of the authorized binding tuple. Kernel still resolves
and validates the exact Model, Harness, Permission Profile, revision, dynamic
health, and capacity for each attempt. Provider configuration and credentials
remain outside the profile.

For the canonical `pi-agent` AgentClass, the registered `pi-cli` Executor
implementation is a composite adapter. Ordinary Subtasks execute through the
operator-provided standard `pi --mode json` CLI. Subtasks requiring
`image-generation` or `image-editing` execute through MetaWork's Image API
Runner using the same authorized binding, model, revision, workspace, input
and Completion Protocol boundaries. The vendored AnyFusion-Pi Planner is never
used as an Executor fallback, and Pi's upstream image mode is not part of the
MetaWork execution contract.

### 2. Generation-scoped authorized binding

Kernel may authorize runtime only through a generation-scoped `AuthorizedExecutorBinding`:

```ts
interface AuthorizedExecutorBinding {
  agentClassRef: string;
  harnessRef: string;
  modelRef: string;
  permissionProfileRef: string;
  configurationRevision: string;
}
```

Runtime receives only the authorized binding. It does not receive the raw Planner proposal as an execution contract and does not infer a different model or harness at launch time.

Each Work Graph generation pins exactly one `configurationRevision`. That revision applies to the generation, all graph revisions, deferred replans, decisions, dispatches, retries, fallbacks, receipts, and recovery packets produced for that generation. Configuration activation affects only future generations. If the current task must adopt new configuration, Kernel must create a new generation rather than mixing revisions inside the existing one.

### 3. Health identities and structured failure subjects

AgentClass, Provider, Model, and binding health are separate Kernel-owned projections. Their identities are revision-scoped so the same name cannot inherit stale health from another configuration revision.

| Projection | Identity |
| --- | --- |
| AgentClass health | `agentClassRef + configurationRevision` |
| Provider health | `providerRef + configurationRevision` |
| Model health | `providerRef + modelRef + configurationRevision` |
| Binding health | authorized binding fingerprint |

The binding health projection tracks the exact authorized tuple, not just the AgentClass name. The fingerprint is revision-scoped because it is derived from the authorized tuple, and it is the appropriate place to distinguish two model choices under one AgentClass.

Normalized failure subjects remain bounded and structured:

```ts
type KernelFailureSubject =
  | { kind: 'attempt'; attemptId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'agent_class'; agentClassRef: string }
  | { kind: 'provider'; providerRef: string }
  | { kind: 'model'; providerRef: string; modelRef: string };
```

Binding health is not a new failure-subject kind. It is recorded through the binding identity so fallback and recovery never collapse distinct authorized tuples into one history row.

Runtime may persist normalized facts, but it may not select fallback, reset cooldown, or widen health scope on its own. Recovery events must carry the health identity and probe generation so old probes cannot overwrite new state.

### 4. Binding-fingerprint fallback history and attempt identity

Runtime derives a stable authorized-binding fingerprint from the full authorized tuple. For fallback history and deterministic attempt identity, it combines that fingerprint with the consuming `generationId`, `subtaskId`, and attempt kind.

The resulting history key must distinguish:

- the authorized tuple itself;
- the generation consuming that tuple;
- the subtask consuming that tuple;
- the attempt kind;
- the ordered fallback chain chosen for that subtask.

As a result, two models under one AgentClass remain distinct attempts and distinct history entries. A deterministic retry of the same authorized attempt reuses the same attempt identity, while a different authorized fallback tuple produces a different identity.

This contract keeps fallback replay-safe without allowing the runtime to invent a new model choice or silently merge separate authorization paths.

### 5. Code-owned Permission Profile grammar

Permission Profile syntax is code-owned, versioned contract, not a free-form configuration language. Configuration may reference only existing profile identifiers and schema-validated parameters. It may not introduce new permission semantics, new resource classes, or new escalation behavior.

The grammar remains consistent with ADR-0024:

- exact Task-registered read partitions may be authorized as read extensions;
- normalized public HTTP(S) targets may be authorized only for `public-web-research`;
- secrets, external mutation, repository promotion, host escape, and other overbroad permissions remain outside the profile grammar.

Any new permission grammar requires a code change and a new ADR or explicit ADR amendment. Configuration stores reference the grammar; they do not own it.

## Out Of Scope

- A2A transport details, remote harness mechanics, and any Scheduler/Router interpretation of remote execution.
- Release transaction, signed cutover, and update rollback mechanics.

## Consequences

- Static routing facts stay separate from dynamic health and from generation-scoped authorization.
- One generation cannot silently drift across configuration revisions.
- Fallback history can distinguish model choice, harness choice, and permission-profile choice under the same AgentClass.
- Permission profiles remain safe, code-owned contracts instead of a configuration DSL.
- ADR-0017, ADR-0018, ADR-0023, and ADR-0024 remain the underlying authority for the split between static catalog, health projection, durable recovery, and resource/permission enforcement.
