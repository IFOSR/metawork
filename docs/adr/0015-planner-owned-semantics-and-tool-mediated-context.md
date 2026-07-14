---
status: accepted
---

# Planner-Owned Semantics And Tool-Mediated Context

## Context

After ADR-0014 established `PlanningAgent -> PolicyKernel -> Runtime`, semantic decisions still leaked into session and task helpers. Keyword lists inferred continuation, recovery, priority, risk, clear scope, durable-task ownership, and natural-language memory capture. Planner input also passively included recent tasks, executor classes, focus state, and rule hints whether they were relevant or not. Executor availability was represented both as static `AgentClass.availability` and as live `WorkUnit` state, while a seeded `executor-1` made capacity appear healthy before any runtime probe.

These overlaps made the same request answerable by several conflicting mechanisms and made Planner behavior difficult to audit.

## Decision

All natural-language semantic interpretation belongs to the Codex `PlanningAgent`. Code may still parse deterministic syntax: slash commands, explicit IDs, paths, URLs, and attachments. `PlanningAgentPlan` is v2 only. It adds `task.priority`; executable work and resume/recovery plans require a non-empty priority, while non-scheduling actions require `null`. The JSON Schema is generated from the Zod contract during image build.

The Planner runs through a dedicated Codex runner with an isolated `CODEX_HOME`, the `metaclaw-planner` core Skill, structured output, JSONL event parsing, an ephemeral read-only sandbox, and a dedicated read-only stdio MCP. Planner and executor Codex configuration and Skills are not shared. Planner failure, timeout, invalid output after one repair, or MCP unavailability fails closed to clarification; no keyword routing fallback is allowed.

Planner startup context contains only user input, trusted session/source identity, authorization boundaries, and timeout. Optional facts are tools, not passive prompt injection. The MCP exposes bounded read-only task search, explicit task context, current-session context, runtime state, and executor catalog/capacity. The host binds the current session; the model cannot request another session. Tool and run audits store only bounded, redacted summaries.

`PolicyKernel` remains deterministic authorization. A state-changing plan with `risk.requiresConfirmation=true` is converted to clarification. A later confirmation or cancellation is a new Planner turn that may inspect recent planning decisions. Invalid status and clear scopes are rejected; unknown clear scope never means `all`. A `direct_reply` plan — a read-only answer the planner already validated — is the one action that skips the `decide()` round-trip: the session calls `PolicyKernel.authorizeDirectReply(plan)`, which the kernel maps to the same `accept` decision `decide()` would return, since no state-changing authorization applies to a reply. The decision is still kernel-constructed and still audited via `planning_decisions`; this is a shortcut through the authorization round-trip, not a bypass of the seam. See ADR-0014.

`AgentClass` is static capability/configuration data. The legacy SQLite `availability` column remains physically present for migration compatibility but application code does not read or write it. Live health and capacity come only from `WorkUnit`. Startup inserts missing built-in AgentClasses without overwriting existing records and does not seed a fictitious executor WorkUnit.

After authorization, Runtime claims a healthy idle WorkUnit or creates a `starting` instance and probes it with `runtimeCheckCommand` or adapter availability. A failed probe becomes `failed`; Runtime tries the next Planner candidate in order. If every candidate fails, the task becomes blocked with a persisted reason and Planner is not called again.

The runtime image contains compiled application and Planner MCP entry points, the generated v2 schema, isolated Planner/Executor Codex templates, Planner Skill, Pi templates, and entrypoint. Hosts inject secrets/environment plus dedicated data and workspace volumes. Source changes require an image rebuild; host `dist`, Codex/PI configs, and entrypoint are not runtime bind mounts.

## Supersedes

- This ADR supersedes ADR-0014's exception that natural-language memory/preference capture fast paths may bypass PlanningAgent. Explicit `/memory add` remains deterministic; natural-language “remember” input is planned normally.
- This ADR supersedes ADR-0013's fixed `planner-1` plus `executor-1` pool. `planner-1` may represent the in-process planner slot, but executor WorkUnits are created and probed on demand.
- ADR-0014's PlanningAgent/PolicyKernel authority boundary and ADR-0013's Task/Subtask/AgentClass/WorkUnit vocabulary otherwise remain in force.

## Consequences

There is one semantic owner and one authorization seam. New tasks do not consume unrelated history, while continuation/status requests can obtain evidence on demand. Static executor capabilities survive restarts without pretending to be runtime health. Runtime fallback is limited to the ordered AgentClass candidates already approved by the plan, except deterministic system resume paths that use the configured default AgentClass.

The first version intentionally does not add preference, long-term-memory, cross-session, or file-body Planner tools; parallel execution; preemption; AgentClass versioning; or Planner replanning after probe exhaustion.
