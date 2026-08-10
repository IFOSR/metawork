# ADR-0018: Supported Routing Contracts and Unified Executor Definitions

- Status: Accepted; historical v3 deferral superseded by ADR-0021 and ADR-0023; module ownership clarified by ADR-0020
- Date: 2026-07-16
- Scope: static built-in Executor capability definitions only

## Context

MetaClaw already injects a static Planner-safe `executorCatalog` and exposes dynamic class health through `list_executor_status`, but the static routing profile, Seeder defaults and Adapter bindings are still maintained separately. Executors also retain overlapping native tools: for example, Pi has workspace read/write and shell tools even though repository engineering should normally prefer Codex.

## Decision

A `Routing Capability` is a supported routing contract used to optimize AgentClass choice; it is not an exhaustive inventory of an Executor's tools, permissions or theoretical abilities. An Executor may retain overlapping native tools without advertising the corresponding capability as a primary routing contract. `primaryUseCases` and `avoidUseCases` guide preference rather than physically enabling or disabling tools.

Built-in Executor definitions become the single static source for the controlled capability registry, `codex-cli` and `pi-agent` routing profiles, Planner-safe affordances, AgentClass seed defaults, Adapter bindings and capability evidence declarations. Planner receives a projection of that source at startup. Dynamic health and recent outcomes remain a separate Kernel Executor Status Projection queried through `list_executor_status`.

The static catalog is versioned and carries definition provenance. Planner and Kernel consume projections derived from the same definitions for one authorization flow. Static projections never contain credentials, runtime commands, WorkUnit claims, heartbeat, health or live capacity. Known untouched seeded rows may be upgraded with a newer built-in definition; user-modified or custom rows must not be silently overwritten, and custom free-form capabilities do not become controlled Routing Capabilities.

For each Subtask, Planner produces one ordered Preferred AgentClass List: the first item is preferred and the remaining items form the fallback chain. The Kernel rechecks the planned list against registered classes and current status before execution, while Runtime attempts the approved order according to existing behavior. (2026-07-27: the deferred automatic cross-class fallback policy was delivered in Phase 4 — ADR-0023 gives `ControlKernel` sole authority to select the next AgentClass after a runtime failure.)

PlanningAgentPlan and Work Graph wire versions, capability-driven candidate derivation, merge rules, parallel Subtasks and asynchronous scheduling are not decided by this ADR. ADR-0021 and ADR-0023 govern the current graph and durable-workflow contracts, while this ADR remains authoritative for static catalog definitions, startup projection and version/provenance rules. The remaining accepted catalog content from ADR-0016 is incorporated here; ADR-0016 is historical.

## Consequences

- Pi keeps its native file and shell tools while research remains its preferred supported route.
- Static capability facts cannot drift independently across Planner projection, Seeder and Adapter binding.
- `list_executor_status` remains authoritative for dynamic class health, not for static capability definitions.
- The current Work Graph contract supersedes the former `candidateAgentClasses` wire-format allowance: executable nodes use controlled requirements and ordered `preferredAgentClassList` values.
- Custom Executor rows are preserved, but their free-form capability strings do not automatically become controlled built-in Routing Capabilities.
