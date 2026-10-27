---
status: accepted
last_updated: 2026-10-26
---

# Long-Term Memory Ownership, Deposition And Delivery

## Context

MetaWork's memory domain was a complete skeleton with a disconnected pipeline.
The storage layer (`preferences`, `preference_usage`), the governance layer
(`learning_candidates`, promotion gates) and the audit layer existed, but no
automatic path wrote conversation experience into memory, no path promoted a
candidate into a usable preference, and the Executor-side automatic injection
was dead code. A heavy user therefore never observed any memory at all.

A self-built extraction and retrieval engine would have had to solve scene
segmentation, memory typing, deduplication, BM25 with Chinese tokenization,
persona synthesis and their storage layout — a large amount of work that a
mature engine already provides. The decision recorded here replaces the dead
pipeline with an external memory engine behind a narrow port, and states the
ownership, deposition, delivery and degradation contracts that the rest of
MetaWork must respect.

The design input is
[`docs/plans/2026-10-22-memory-system-tdai-integration-design.md`](../plans/2026-10-22-memory-system-tdai-integration-design.md).
The engine is TencentDB Agent Memory (TDAI) MemoryCore, MIT licensed by
Tencent. Only its L0/L1/L2/L3 data plane and `/v3/meta/*` metadata plane are
used. MemoryProxy, MemoryPanel and MemoryKnowledge are explicitly out of scope.

## Decision

### 1. One engine, one port

TDAI MemoryCore is the **only** memory engine. MetaWork does not implement
extraction, retrieval, ranking or persona synthesis of its own. The former
local chain — `preferences`, `preference_usage`, `learning_candidates`,
`reflection_events`, `MemoryEngine`, `context-recaller`, `memory-context-service`,
`reflection-engine`, `promotion-gate` and `ContextRef{kind:'preference'}` — is
retired from production and from the schema. The 2026-10-26 amendment below
supersedes the earlier compatibility-alias decision.

All cross-process memory access happens behind one **Memory Port**
(`src/memory/memory-port.ts`). No module talks to the engine directly. The port
has four seams:

| Seam | Consumer | Operation | Timing | Failure behavior |
|---|---|---|---|---|
| S1 deposit | MetaWork Server | write the L0 conversation segment | after the conversation goes idle | dropped and logged; no conversation or execution impact |
| S2 recall candidates | Planner MCP tools | search the L1 atoms | during a planning turn | empty result with a `degraded` flag; planning continues |
| S3 materialize | execution context build | read one atom body | before an attempt starts | the evidence is unavailable and the failure is explicit |
| S4 asset governance | Web settings | list / disable / delete assets | user action | the page shows the error |

### 2. The account is the only isolation boundary

Memory belongs to the **account**. Workspaces, agent roles and conversations are
provenance labels, never boundaries. One account therefore has one fixed TDAI
isolation triple (`team_id`, `agent_id`, `user_id`), and every AgentClass of
that account shares the same `agent_id`, so a practice learned in one role is
recallable from every other role.

The local `memory_bindings` table is the only MetaWork-side memory index. It
holds ownership, the user switch, the provenance workspace and a content
digest. It never holds a memory body: the body lives in the engine, so the
engine can be discarded and rebuilt without losing the user's decisions.

### 3. Deposition is batched, completed-turns only

The write unit is a conversation **Turn** (`userInput` plus `finalAnswer`). A
conversation is one L0 session. A batch is "every turn since the last
deposition", written in one call.

Deposition happens when the conversation goes idle, never while an answer is
being produced. Turn-by-turn deposition is explicitly rejected: the engine can
only recognize a cross-turn preference ("以后都用中文表格") when it reads the
whole segment, and a per-turn write would instead produce fragments and
task-summary noise.

Only turns with `status='completed'` are deposited. Failed, cancelled and
blocked rounds never become durable experience.

The deposition cursor advances only after the engine accepted the batch, so a
failed deposition is retried on the next tick instead of losing the segment.

### 4. Memory is an optional capability

`memory.enabled=false` means no sidecar process, no request, no model cost and
no index. The extraction model is chosen explicitly by the user from the
providers they already configured. The system enforces only hard constraints —
the Provider protocol must be `openai-compatible`, the Provider and the Model
must be enabled, the Model must belong to that Provider, and the Model must
declare the `structured-output` capability. It never recommends a model, never
downgrades one, and never fills the choice in.

The extraction credential is read from the SecretStore on demand and injected
into the sidecar environment only. It never enters the Server's own
`process.env`, which the Planner process tree inherits. The Executor container
receives no memory credential and no memory network route.

### 5. Delivery is pull-only, through the evidence channel

Memory reaches an Executor through exactly one channel:
`task_execution_evidence` with `kind='long_term_memory'`.

The Planner references a memory with `ContextRef{kind:'memory', memoryId}`. The
Runtime re-validates the reference (account ownership, enabled state), fetches
the body on the host side, materializes it as evidence, and the Executor
receives it in `selectedEvidence`. The existing ADR-0021 budget (4,000
characters per item, 24,000 per task) and the `executor_evidence_accessed`
audit apply unchanged.

A memory is never spliced into the prompt body. That would create a second,
unbudgeted and unaudited context path and contradict ADR-0038 and ADR-0021. A
memory that cannot be materialized is an explicit failure: an empty body is
never passed off as evidence.

### 6. The Planner never reaches the engine

The Planner process tree may not hold engine credentials and may not talk to
the engine. The Server owns the adapter, performs the recall and projects a
bounded preview into the account database; the Planner reads that read model
through the `search_memory` and `list_memory_assets` MCP tools, exactly as it
already reads tasks, interactions and the memory read model from the database.
The full body only ever reaches the Runtime through the evidence channel.

### 7. Sanitization happens before deposition

The retired candidate scanner is repurposed as a pre-deposition purifier.
Secret-like content is redacted before it is written, so the engine never holds
the secret. Content whose secret cannot be masked is refused outright.
Dangerous-command content is deposited but marked as sanitized. A re-bind never
re-enables an asset the user disabled.

### 8. Degradation never fails a task

When the engine is unavailable, deposition is dropped and logged, recall
returns an empty result with a `degraded` flag, materialization fails
explicitly, and governance actions report the error. The conversation path and
the task execution path are never failed by a memory problem.

The engine's BM25 recall depends on SQLite FTS5. Without FTS5 the recall
silently returns nothing, so the FTS5 availability reported by the engine
health check is a **blocking** gate: the memory seam stays closed rather than
appearing to work.

## Contracts

1. **Single port** — cross-process memory access happens only through the Memory
   Port.
2. **Single direction** — MetaWork is the only client; the engine never calls
   back.
3. **Process boundary** — the Executor container has no memory credential and no
   memory network route; memory bodies are materialized on the host side.
4. **Credential discipline** — engine credentials are read from the SecretStore
   on demand and never enter the Server's `process.env`.
5. **Pull semantics** — memory reaches an Executor only through
   `task_execution_evidence`.
6. **Degradation contract** — an unavailable engine yields empty recall with a
   `degraded` flag and never fails the task chain.
7. **Permission discipline** — the account identity is the durable namespace
   inside one installation. The installation/Server user key is read-only and
   revocable and is not a per-account credential.
8. **Single write direction** — MetaWork writes the L0 conversation layer only;
   L1/L2/L3 are produced by the engine and only indexed locally.

## Consequences

A user can now observe memory: a stated preference in one session is
extracted, recalled in a later session, and delivered to the Executor as
auditable evidence. The user can see, disable and delete every memory asset,
and can switch the whole capability off.

The cost is a second process and a new dependency direction: MetaWork depends
on the engine's v3 contract, and the engine's version is pinned independently
of MetaWork's release cycle. The contract is confined to one anti-corruption
layer so that a v3 change lands in one file.

The account-scoped sharing model means a preference learned in one workspace
affects the account's other workspaces and roles. That is the intended
behavior: memory exists to understand the user, not to partition them. Only
conversationally derived preferences and practices are stored — never file
contents and never artifact bodies.

The retired local memory tables no longer exist after schema 59. A persisted
payload that still references `ContextRef{kind:'preference'}` fails closed and
requires a new plan; it is never converted into a TDAI binding or evidence.

## Related authority

- ADR-0015 is amended: cross-session semantic search is no longer unavailable,
  and the natural-language capture fast path stays retired.
- ADR-0020 is adjusted: the memory domain owns binding, governance and
  delivery, not a self-built extraction and retrieval implementation.
- ADR-0021 is unchanged: the evidence channel, budget and audit already govern
  memory delivery.
- ADR-0031 and ADR-0047 align: the memory isolation domain is the account, and
  extraction spend belongs to the user-selected Provider.
- ADR-0034 and ADR-0045 align: the engine sidecar joins the installation,
  upgrade, stop and Desktop lifecycle transactions.
- ADR-0042 is reused: extraction is external consumption and is accounted
  separately.

## Amendment 2026-10-26 — Server-owned runtime, schema 59, and removal of the local chain

The product boundary is one MetaWork installation per local customer: one local
Server, one `local-default` AccountRuntime and one TDAI sidecar. The
`MemoryRuntimeController` therefore stays Server-owned and is created once by
`src/server/server-composition.ts`; it is not moved down into each
AccountRuntime. `accountId` remains the durable persistence, Port, eligibility
and evidence namespace, and every memory SQL query keeps its `account_id`
predicate.

The fixed SecretStore reference is renamed to
`MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE` to state that it is an
installation/Server secret, not evidence that per-account user keys already
exist. The SecretStore lives in the installation's own data directory, so
different installations never share it.

The earlier compatibility decision is withdrawn. The following are removed
from production composition and from the normal conversation path:

- `MemoryEngine`, `PreferenceRepo`, `ContextRecaller`, `MemoryContextService`
  (`src/memory/memory-context-service.ts`), `memory-vault-exporter`, the
  learning/reflection/promotion modules and the `/memory`, `/learning` and
  profile-preference commands;
- `ContextRef{kind:'preference'}`, preference evidence and
  `tasks.injected_prefs_json`;
- the `preferences`, `preference_usage`, `reflection_events` and
  `learning_candidates` tables and indexes.

`src/intent/inline-resource-normalization.ts` owns inline-resource parsing that
was previously reached through `MemoryContextService`; it has no memory
dependency. The only automatic deposition path is
`MemoryFlushScheduler → MemoryService → MemoryPort → TDAI`; the only long-term
memory planning path is
`refreshRecall → memory_recall_candidates → search_memory → ContextRef{kind:'memory'}`.

Schema 59 is the memory migration on top of main's schema 58. A database stamped
53 by the memory branch is identified explicitly and fails closed when it lacks
main's six-state Task base; it is never silently treated as main's 53. The
58 → 59 migration drops the legacy tables and `tasks.injected_prefs_json`,
deletes preference evidence, removes preference ContextRefs from stored work
graphs, fails pending/replan Planner payloads that still contain one, and marks
an affected active Task `needs_action` with a reason that explicitly requires a
new plan.

A disabled, needs-model or degraded runtime clears the conversation's recall
candidates and records the runtime mode in `memory_runtime_state`; the Planner
tools gate on that durable mode rather than on local bindings alone. The manager
view returns a structured degraded state so the settings page never renders
"no assets" for an unavailable engine. The deposition fallback forces a flush
when a conversation has at least one completed turn and two hours have passed
since the last successful deposition; failures never move that clock.

See
[`docs/plans/2026-10-26-server-scoped-memory-pre-merge-remediation.md`](../plans/2026-10-26-server-scoped-memory-pre-merge-remediation.md).

## Amendment 2026-10-26 — the engine ships with the release

The original decision kept the engine version independently pinned but did not
say who installs it. In practice that left a `memory.enabled` switch in the
product whose engine the user had to fetch, build and run themselves; the
installer never created `<releaseRoot>/memory/tdai`, so every real installation
ran with `engine_missing`.

The engine is now a required part of every release:

- `memory/engine.lock.json` pins the upstream MIT revision; CI fetches exactly
  that commit, builds the compiled gateway and packages it as the `memory`
  artifact (source, revision, size, SHA-256 and dependency-lock SHA-256).
- The release manifest requires the `memory` artifact; `install.sh`,
  `bootstrap-install.sh`, `install.ps1`, the native installer/updater and the
  Desktop payload all extract it to `<releaseRoot>/memory/tdai` and verify the
  archive before use.
- `resolveMemorySidecarCommand` accepts the compiled
  `dist/gateway/server.js` (releases) and the development
  `src/gateway/server.ts`, so development and production use one path.
- The build fails unless the packaged engine starts and reports
  `stores.ftsAvailable === true`; the FTS5 gate is verified before shipping
  rather than discovered by a user.
- "Engine not installed", "engine unreachable", "engine unhealthy" and "FTS5
  unavailable" are distinct management states; the settings page no longer
  reports every failure as an FTS5 problem.

Nothing else about the capability changes: `memory.enabled=false` still starts
no process, sends no request and costs nothing.
