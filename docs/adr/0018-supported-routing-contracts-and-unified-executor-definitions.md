# ADR-0018: Supported Routing Contracts and Unified Executor Definitions

- Status: Accepted; historical v3 deferral superseded by ADR-0021 and ADR-0023; module ownership clarified by ADR-0020
- Date: 2026-07-16
- Scope: static built-in Executor capability definitions only

## Context

MetaClaw already injects a static Planner-safe `executorCatalog` and exposes dynamic class health through `list_executor_status`, but the static routing profile, Seeder defaults and Adapter bindings are still maintained separately. Executors also retain overlapping native tools: for example, Pi has workspace read/write and shell tools even though repository engineering should normally prefer Codex.

## Decision

A `Routing Capability` is a supported routing contract used to qualify and
rank AgentClass choice; it is not an exhaustive inventory of an Executor's
tools, permissions or theoretical abilities. An Executor may retain overlapping
native tools without advertising the corresponding capability as a routing
contract.

The controlled capability registry and built-in Executor definitions remain
code-owned inputs. For each enabled Executor and configuration revision,
Configuration compiles one `ExecutorCapabilityProfile` from its effective
Models, controlled affordances, configured declarations, and user semantics.
The Skill-style manual, read-only tags, capability evidence, dispositions, and
Routing Catalog entry are projections of that same profile and source
fingerprint. Dynamic health and recent outcomes remain a separate Kernel
Executor Status Projection queried through `list_executor_status`.

The static catalog is versioned and carries definition provenance. Planner and Kernel consume projections derived from the same definitions for one authorization flow. Static projections never contain credentials, runtime commands, WorkUnit claims, heartbeat, health or live capacity. Known untouched seeded rows may be upgraded with a newer built-in definition; user-modified or custom rows must not be silently overwritten, and custom free-form capabilities do not become controlled Routing Capabilities.

The controlled registry may define a model-derived Routing Capability when
eligibility has an exact structural Model requirement. As of the 2026-08-31
amendment, `image-generation` requires the Model capability
`image-generation`, and `image-editing` requires `image-editing`. System-known,
Provider-declared, or user-confirmed registered model capability evidence may
satisfy that requirement only for an enabled Model inside the Executor's
effective fixed/Auto policy. User semantics can set a supported capability to
`preferred`, `allowed`, `avoid`, or `disabled`, but cannot create an unknown
capability or make an unsupported capability routable. During authorization,
Kernel filters concrete model candidates by the corresponding mandatory model
capability before scoring preferences or the Auto default.
Image generation and editing Subtasks must use `deliveryKind: edit`, and
Completion Protocol certification requires at least one changed image artifact
with a valid bounded PNG, JPEG, WebP, or GIF signature read.

For each Subtask, Planner produces one ordered Preferred AgentClass List: the first item is preferred and the remaining items form the fallback chain. The Kernel rechecks the planned list against registered classes and current status before execution, while Runtime attempts the approved order according to existing behavior. (2026-07-27: the deferred automatic cross-class fallback policy was delivered in Phase 4 — ADR-0023 gives `ControlKernel` sole authority to select the next AgentClass after a runtime failure.)

PlanningAgentPlan and Work Graph wire versions, capability-driven candidate derivation, merge rules, parallel Subtasks and asynchronous scheduling are not decided by this ADR. ADR-0021 and ADR-0023 govern the current graph and durable-workflow contracts, while this ADR remains authoritative for static catalog definitions, startup projection and version/provenance rules. The remaining accepted catalog content from ADR-0016 is incorporated here; ADR-0016 is historical.

## Consequences

- Pi keeps its native file and shell tools while research remains its preferred supported route.
- Capability manuals and Catalog qualification cannot drift because both are
  compiled from one per-Executor profile.
- `list_executor_status` remains authoritative for dynamic class health, not for static capability definitions.
- The current Work Graph contract supersedes the former `candidateAgentClasses` wire-format allowance: executable nodes use controlled requirements and ordered `preferredAgentClassList` values.
- Custom Executor rows are preserved, but their free-form capability strings do not automatically become controlled built-in Routing Capabilities.
