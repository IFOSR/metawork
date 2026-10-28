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
Executor receives the tool registry declared by its Executor registration
(`read`, `bash`, `edit`, `write` for the standard workspace class; Pi's own
default registry is used when no projection is supplied) unless the Executor's
own explicit response-only entrypoint requests a reduced surface. The Runtime's
`workspaceAccess` remains a filesystem/prompt boundary;
it must not remove `bash` from a normal Attempt. Host/container enforcement is
responsible for making that boundary real. Fine-grained escalation remains a
Harness/Host policy decision and is recorded as an execution fact.

## Consequences

- A `read_only` or `run_in_target` semantic classification no longer causes a
  native Pi Attempt to lose shell access.
- Native and container Pi launches use the same Executor-owned default tool
  surface; response-only correction remains explicitly tool-reduced.
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

The Pi driver regression test verifies that `workspaceAccess: 'read'` does not
add `--tools read` or `--no-session`; only the explicit response-only launch
uses that reduced surface. `npm run lint`, the focused Pi driver tests and
`git diff --check` are required for the implementation change.

