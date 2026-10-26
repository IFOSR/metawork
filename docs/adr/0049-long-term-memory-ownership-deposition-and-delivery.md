---
status: accepted
last_updated: 2026-10-22
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
extraction, retrieval, ranking or persona synthesis of its own. The retired
`preferences` projection, `preference_usage`, `learning_candidates`,
`reflection-engine`, `promotion-gate`, `context-recaller` and the unused part of
`memory-context-service` remain only as compatibility aliases for the retired
`ContextRef{kind:'preference'}` contract; they are not a second memory system.

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
already reads tasks, interactions and preferences from the database. The
full body only ever reaches the Runtime through the evidence channel.

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
7. **Permission discipline** — the account scope is the only isolation
   boundary; a user-level key is read-only and revocable.
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

`preferences` and the retired learning tables remain in the schema for
compatibility with the historical `ContextRef{kind:'preference'}` contract and
with existing installations. They are no longer a live pipeline.

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
