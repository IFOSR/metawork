# ADR-0018: Supported Routing Contracts and Unified Executor Definitions

- Status: Accepted
- Date: 2026-07-16
- Scope: static built-in Executor capability definitions only

## Context

MetaClaw already injects a static Planner-safe `executorCatalog` and exposes dynamic class health through `list_executor_status`, but the static routing profile, Seeder defaults and Adapter bindings are still maintained separately. Executors also retain overlapping native tools: for example, Pi has workspace read/write and shell tools even though repository engineering should normally prefer Codex.

## Decision

A `Routing Capability` is a supported routing contract used to optimize AgentClass choice; it is not an exhaustive inventory of an Executor's tools, permissions or theoretical abilities. An Executor may retain overlapping native tools without advertising the corresponding capability as a primary routing contract. `primaryUseCases` and `avoidUseCases` guide preference rather than physically enabling or disabling tools.

Built-in Executor definitions become the single static source for the controlled capability registry, `codex-cli` and `pi-agent` routing profiles, Planner-safe affordances, AgentClass seed defaults, Adapter bindings and capability evidence declarations. Planner receives a projection of that source at startup. Dynamic health and recent outcomes remain a separate Kernel Executor Status Projection queried through `list_executor_status`.

For each Subtask, Planner produces one ordered Preferred AgentClass List: the first item is preferred and the remaining items form the fallback chain. PolicyKernel rechecks the planned list against registered classes and current status before execution, while Runtime attempts the approved order according to existing behavior. Automatic cross-class fallback policy after runtime failure remains deferred; retaining overlapping native tools deliberately preserves that future option.

PlanningAgentPlan v3, capability-driven candidate derivation, work-graph merge rules, parallel Subtasks and asynchronous scheduling are not part of this decision. In particular, the work-graph decomposition and shared structural-rule commitments in ADR-0016 are deferred and superseded by this ADR; ADR-0016's static catalog injection and built-in definition versioning decisions remain in force.

## Consequences

- Pi keeps its native file and shell tools while research remains its preferred supported route.
- Static capability facts cannot drift independently across Planner projection, Seeder and Adapter binding.
- `list_executor_status` remains authoritative for dynamic class health, not for static capability definitions.
- Existing `candidateAgentClasses` may continue as the wire/storage representation of the Preferred AgentClass List; schema renaming is outside this scope.
- Custom Executor rows are preserved, but their free-form capability strings do not automatically become controlled built-in Routing Capabilities.
