# ADR-0052: Executor-Owned Tool Capabilities And Kernel Boundary

- **Status**: Superseded by [ADR-0053](0053-planner-graph-coordinator-and-executor-authority.md) for Kernel strategic authority; the Executor-owned tool surface remains accepted
- **Date**: 2026-10-28
- **Amends**: ADR-0020, ADR-0022, ADR-0024, ADR-0046, ADR-0050

## Context

MetaWork previously projected the Planner's `workspaceIntent.operation` into an
Executor launch allowlist. A native Pi Attempt with `read_only` therefore
started as `pi --tools read`, while the same class in the container path kept
Pi's normal tool set. A Planner classification error could consequently remove
the shell tool before the Executor had a chance to inspect or run the target.
That is a capability ownership error, not a missing user approval.

The comparison systems confirm the intended boundary. Pi's normal Agent session
owns its tool registry and agent loop; its host chooses which tools to register,
while the loop executes tool calls and continues until the turn settles. DeepSeek
Harness exposes the same split through `dsh-agent-loop`, tool plugins such as
`dsh-tool-bash`, and a host-provided `sandboxPolicy`. The Harness/Host chooses
the actual sandbox and approval path; no Planner-shaped Kernel translates a
semantic workspace label into the tool list. See the vendored Pi
`packages/coding-agent/docs/security.md` and the published DeepSeek packages
`@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-tool-bash`, and
`@deepseek-ai/dsh-sandbox`.

## Decision

ADR-0053 supersedes this ADR's decision to retain the Kernel as a durable
strategic control plane. The tool ownership and Planner `workspaceIntent`
rules below remain current; capability grant/deny/escalate is now an
Executor/Host concern and is no longer wired through `ControlKernel`.

Planner owns user-meaning interpretation and Work Graph decomposition. Its
`workspaceIntent` remains a declaration of the requested Workspace effect and
target paths so the system can validate containment, delivery, leases and
postconditions. It is not a tool allowlist and must never imply that shell,
edit, write, web or other Harness tools are unavailable.

Kernel remains the durable control plane because MetaWork needs cross-turn and
cross-process facts that an Agent loop does not provide: graph admission,
authorization identity, resource leases, attempt settlement, publication and
crash recovery. Kernel reviews the graph and applies those durable policies. It
does not choose a Harness tool set, implement the Harness retry/repair loop, or
promote an individual command failure into a user decision.

Executor/Harness owns the execution loop and its available tools. A normal Pi
Attempt runs Pi's complete tool registry: the built-in workspace tools plus every
extension the Executor materialized for that Attempt (web tools, evidence and
ResultReference tools, pdf tools). Pi's `--tools` flag is a global allowlist that
also covers extension and custom tools, so deriving it from a workspace class or
an affordance projection silently deletes extension tools; an executing Attempt
must not be launched with it. Executor affordances still decide what gets
materialized — the web extension follows the web affordances, and
evidence/ResultReference tools are installed for bound Attempts — never what gets
removed at launch. The only intentionally reduced launch is the Executor's own
explicit response-only correction entrypoint, whose contract is one completion
trailer and no action: it runs with no tools and no durable session. The
Runtime's `workspaceAccess` remains a filesystem/prompt boundary; it must not
remove `bash` from a normal Attempt. Host/container enforcement is responsible
for making that boundary real. Fine-grained escalation remains a Harness/Host
policy decision and is recorded as an execution fact.

## Consequences

- A `read_only` or `run_in_target` semantic classification no longer causes a
  native Pi Attempt to lose shell access.
- An executing Attempt keeps Pi's complete registry, including the extension
  tools the Executor materialized for it; affordances control materialization,
  not launch-time removal. Response-only correction runs with no tools at all.
- Planner manuals must describe effects and acceptance, not concrete tool
  permissions. AgentClass/Harness configuration may still advertise supported
  affordances for routing and host registration.
- The Kernel is retained for durable coordination and recovery. Removing it
  would move leases, authorization, publication and crash convergence into the
  short-lived Harness and would make those invariants non-durable.
- Native read-only enforcement remains a follow-up host-sandbox concern. The
  prompt and Runtime facts communicate the boundary today; a future enforcing
  backend may constrain file effects without changing Planner or Kernel
  ownership.

## Validation

The Pi driver regression tests verify that a normal Attempt launch carries no
`--tools`/`--no-tools` flag even when Executor affordances are published, and that
only the explicit response-only launch uses the reduced surface (`--no-session`
with no tools). `npm run lint`, the focused Pi driver tests and
`git diff --check` are required for the implementation change.

## Amendment: no launch-time tool allowlist (2026-11-05)

The 2026-10-28 implementation of the paragraph above derived `--tools
read,bash,edit,write` from the Executor affordance projection for every Attempt
that published one, which is effectively every Attempt. Because Pi's `--tools`
also filters extension-registered tools, `web_search`, `web_fetch`,
`evidence_*`, `result_reference_*` and the `pdf_*` tools disappeared from all
Attempts from that date, contradicted this ADR's own materialization rules, and
made every dependent Subtask improvise around a documented tool it did not have
(the 2026-11-05 incident: a comparative Subtask spent 26 minutes scanning 190 GB
of account data with `grep` to locate an upstream ResultReference). Launch-time
tool allowlists are therefore removed for executing Attempts; the affordance
projection controls only what the Executor materializes. Response-only
correction keeps the reduced surface and now runs with no tools instead of
`read`.

