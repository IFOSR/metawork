---
status: accepted
amended_by: ADR-0017, ADR-0018, ADR-0020, ADR-0021, ADR-0022, ADR-0023
---

# Planner-Owned Semantics And Tool-Mediated Context

> Architecture alignment (2026-07-17): Planner semantic ownership, isolated execution, bounded context and fail-closed behavior remain accepted. PlanningAgentPlan v2, WorkUnit-only class health, Runtime-owned strategic fallback, configured-default resume routing and the `authorizeDirectReply` target exception are superseded by ADR-0017 through ADR-0020.

## Context

After ADR-0014 established `PlanningAgent -> PolicyKernel -> Runtime`, semantic decisions still leaked into session and task helpers. Keyword lists inferred continuation, recovery, priority, risk, clear scope, durable-task ownership, and natural-language memory capture. Planner input also passively included recent tasks, executor classes, focus state, and rule hints whether they were relevant or not. Executor availability was represented both as static `AgentClass.availability` and as live `WorkUnit` state, while a seeded `executor-1` made capacity appear healthy before any runtime probe.

These overlaps made the same request answerable by several conflicting mechanisms and made Planner behavior difficult to audit.

## Decision

All natural-language semantic interpretation belongs to the Codex `PlanningAgent`. Code may still parse deterministic syntax: slash commands, explicit IDs, paths, URLs, and attachments. ADR-0021 and ADR-0023 own the current Work Graph/Planning contract and durable evolution; this ADR does not define a parallel plan version or semantic defaults.

The Planner runs through a dedicated Codex runner with an isolated `CODEX_HOME`, the `metaclaw-planner` core Skill, structured output, JSONL event parsing, an ephemeral read-only sandbox, and a dedicated read-only stdio MCP. Planner and executor Codex configuration and Skills are not shared. Planner failure, timeout, invalid output after one repair, or MCP unavailability fails closed to clarification; no keyword routing fallback is allowed.

Planner startup context contains user input, trusted session/source identity, authorization boundaries, timeout, bounded confirmed global memory, bounded current-session conversation history and the ADR-0018 static Planner-safe catalog. The memory/history/catalog block is assembled before each `PlanningAgent.plan()` call; later direct replies are persisted as interactions and become input to subsequent turns. Other optional facts remain tools rather than passive prompt injection. Planner MCP exposes bounded read-only task/session/runtime context and ADR-0017 dynamic executor status, not a second static catalog or raw capacity pool. The host binds the current session; the model cannot request another session. Tool and run audits store only bounded, redacted summaries.

`PolicyKernel` remains deterministic authorization. A state-changing plan with `risk.requiresConfirmation=true` is converted to clarification. A later confirmation or cancellation is a new Planner turn that may inspect recent planning decisions. Invalid status and clear scopes are rejected; unknown clear scope never means `all`. (2026-07-27: ADR-0022 renamed this seam to `ControlKernel` and removed the `authorizeDirectReply` shortcut ADR-0014 recorded; there is now exactly one public decision Interface.)

`AgentClass` and Routing Capability definitions are static catalog data governed by ADR-0018. Dynamic class health and recent outcomes come from the bounded ADR-0017 projection; WorkUnit state remains instance/claim/heartbeat fact and is not interchangeable with class health. Startup inserts or upgrades eligible built-in definitions according to provenance rules, does not overwrite user-modified/custom rows, and does not seed a fictitious executor WorkUnit.

After authorization, Runtime follows the Kernel-approved v3 `preferredAgentClassList` for claim/probe mechanics: it may claim an idle WorkUnit or create/probe a `starting` instance, and a failed probe becomes a Runtime fact. Runtime does not switch AgentClass after execution failure or decide the terminal Task action. (2026-07-27: Phase 3–4 completed this move — capacity exhaustion, retry, fallback, replan and terminal policy are now decided only by `ControlKernel`.)

The runtime image contains compiled application and Planner MCP entry points, the generated current schema, isolated Planner/Executor Codex templates, Planner Skill, Pi templates, and entrypoint. Hosts inject secrets/environment plus dedicated data and workspace volumes. Source changes require an image rebuild; host `dist`, Codex/PI configs, and entrypoint are not runtime bind mounts.

## Supersedes

- This ADR supersedes ADR-0014's exception that natural-language memory/preference capture fast paths may bypass PlanningAgent. Explicit `/memory add` remains deterministic; natural-language “remember” input is planned normally.
- This ADR superseded the historical ADR-0013 fixed `planner-1` plus `executor-1` pool. `planner-1` may represent the in-process planner slot, but executor WorkUnits are created and probed on demand.
- ADR-0020 is authoritative for the PlanningAgent/Kernel/Runtime module chain and vocabulary ownership; ADR-0022 is authoritative for the Kernel decision Interface. ADR-0021 and ADR-0023 govern the current Work Graph and durable execution contracts.

## Consequences

There is one semantic owner and one logical authorization seam. New tasks do not consume unrelated history, while continuation/status requests can obtain evidence on demand. Static Routing Catalog facts survive restarts without pretending to be runtime health. Runtime follows approved claim/probe order but owns no post-failure fallback or configured-default resume policy.

The first version intentionally does not add preference, long-term-memory, cross-session, or write-capable Planner tools. Confirmed global memory and current-session conversation history are instead provided through the bounded startup context; cross-session semantic search remains unavailable. Parallel execution, preemption, AgentClass versioning, and Planner replanning after probe exhaustion also remain out of scope.

## Amendment: bounded initial memory context

As of 2026-07-15, the Planner receives confirmed global memory up to `top_k_preferences` plus bounded current-session conversation history at the start of each planning turn. This closes the `direct_reply` gap where explicit `/memory add` records were persisted but invisible to the agent producing the answer. The block is read-only data, current user input and authorization rules retain precedence, and task execution keeps its existing independent memory review and injection path.

## Amendment: read-only file access for the Planner

The Planner may now read repository file bodies. It is given a shell (`shell_tool`/`unified_exec` enabled) so it can `grep`/`cat`/`ls` source files and answer code questions directly — for a `direct_reply`, it inspects the files itself instead of proposing executable work. This supersedes the original decision to withhold file-body Planner tools.

Write protection is enforced at the OS layer, not by withholding the shell: the Planner Codex runs with `sandbox_mode = "read-only"` (reinforced by the runner's `--sandbox read-only` flag), so reads succeed and every write is denied. On Linux this sandbox uses bubblewrap, which requires unprivileged user namespaces; the runtime container is therefore created with `--security-opt seccomp=unconfined` (granted once at `docker run`, reused across stop/start — see `docker/shell.ps1`). Without it bwrap cannot create a namespace and the shell tool fails closed (no reads, no writes). The Planner remains read-only; nothing about this grants it the ability to change state.

## Amendment: tool-mediated runtime diagnostics

Runtime failures, interruptions and recovery facts are not passive Planner context. The owning Runtime or adapter persists a bounded, redacted reason at the point where the failure is observed. Planner receives that evidence only through an explicit read-only diagnostic tool when the user asks why execution is blocked or unavailable, and explains the persisted fact in natural language. Raw logs, credentials and write authority remain outside the Planner interface.

## Amendment: native Codex conversation ownership

As of 2026-07-30, this amendment supersedes the earlier ephemeral-runner and
per-turn startup-context rules. One live MetaClaw session is bound to one native
Codex thread: the first Planner turn uses `codex exec`, captures
`thread.started.thread_id`, and later turns use `codex exec resume` with that
thread. Codex owns dialogue history and compaction. MetaClaw keeps only the
in-process `sessionId -> threadId` resume handle for this pre-release scope; it
does not replay a second model conversation.

Stable Planner authority is registered through native Codex mechanisms:
`developer_instructions`, the `metaclaw-planner` Skill, the structured output
schema, and the session-scoped read-only MCP. Each turn sends only the current
user input; one validation repair sends only validation errors in the same
thread. Confirmed preferences, canonical routing facts, exact pending
authorization, task/runtime state and diagnostics are queried through MCP when
needed rather than serialized into every prompt.

SQLite interactions and Kernel decisions remain durable product audit/query
facts. They are not reconstructed into Codex dialogue history.
