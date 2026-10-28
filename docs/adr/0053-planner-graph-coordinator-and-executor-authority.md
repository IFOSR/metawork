# ADR-0053: Planner Graph, Durable Coordinator And Executor Authority

- **Status**: Accepted; supersedes the strategic-authority portions of ADR-0020, ADR-0022, ADR-0023, ADR-0024 and ADR-0052
- **Date**: 2026-10-28
- **Scope**: Planner decomposition, Work Graph execution, capability decisions and the remaining Kernel implementation

## Context

Planner was introduced for three product reasons: users can see the workflow,
independent graph nodes can run in parallel, and a complex request can be
delegated to smaller Executor turns and simpler models. It was not introduced
as a permission broker or a second security boundary.

The previous control story made `ControlKernel` the strategic authority for
graph admission, dispatch, retries, recovery and capability grant/deny/escalate.
That made a semantic Planner field capable of indirectly changing an Executor's
tools, and made a capability request wait for a Kernel interpretation even when
the Executor and its Host already had the information required to decide it.
The first failure was visible as `pi --tools read` for an ordinary Attempt. This
was a boundary error, not missing user authorization.

Pi and DeepSeek Harness use a simpler split. The Agent/Harness owns its tool
registry and turn loop. The Host/Runtime owns the process, sandbox and approval
boundary. A planning layer may produce structured work, but it does not sit in
the tool-call loop. MetaWork needs additional durable facts for Tasks,
Subtasks, graph dependencies, parallel frontier, publication and crash
recovery, but those facts do not require a security Kernel.

## Decision

### Product control flow

The target flow is:

```text
User -> Planner -> Work Graph -> Durable Task Coordinator -> Executor/Harness
                                      ^                         |
                                      |--- facts, receipts, ---|
                                           publication, recovery
```

Planner owns user-meaning interpretation and graph decomposition. Work Graph
owns pure schema, DAG, dependency and runnable-frontier rules. The Durable Task
Coordinator owns persistence, Task/Subtask lifecycle, graph materialization,
parallel claims, leases, publication ordering and crash convergence. It may
reject an invalid graph or stale identity, but it does not interpret tool
permissions and does not act as a security gate.

Executor/Harness owns the available tools, the model turn loop, tool-call
retry/repair, and the capability request it needs for the current operation.
The Runtime/Host enforces the actual process, filesystem, network, credential,
container and operating-system boundaries. A model cannot grant itself an OS
privilege merely by requesting it; the Host policy remains the enforcing
boundary. The Executor decides which registered capability is needed and asks
the Host through the capability port.

The current `ControlKernel` and `DurableKernelWorkflow` are a migration
compatibility implementation of the Durable Task Coordinator. New code must
not add Kernel-owned permission, tool-selection, Harness retry, fallback or
repair policy. The production capability path now evaluates the Executor/Host
policy directly in `PermissionWorkflowService`; resolution and request facts
remain durable for UI, audit and recovery. The old Kernel permission methods
remain only for replay compatibility and are not wired by the production
composition.

### Responsibility matrix

| Concern | Owner | Kernel status |
| --- | --- | --- |
| Intent understanding and graph decomposition | Planner | never decides |
| Graph schema, DAG and runnable frontier | Work Graph | pure rules only |
| Task/Subtask lifecycle and durable facts | Task Coordinator/Storage | coordinator concern |
| Parallel claims and lease application | Runtime/Coordinator | coordinator concern |
| Tool registry and agent loop | Executor/Harness | never Kernel-owned |
| Capability needed for the current operation | Executor | never Planner-owned |
| OS/filesystem/network/credential enforcement | Runtime/Host/Sandbox | security boundary |
| Tool retry, repair and provider backoff | Executor/Harness | stays inside Attempt |
| Publication, delivery and crash recovery | Runtime/Coordinator | durable facts and idempotent effects |
| Semantic graph validity and stale identity | Work Graph/Coordinator | admission check, not permission |

### Why a durable coordinator remains

Removing the Kernel *name* does not remove the need for durable coordination.
An in-process Harness cannot safely own a cross-process Task state machine,
parallel frontier, leases, publication ordering or restart recovery. Those
responsibilities remain necessary for the product. They are application and
runtime coordination responsibilities and may be extracted from `src/kernel/`
into a `TaskCoordinator` module in a later migration. Keeping a compatibility
package temporarily is acceptable; keeping it as a strategic permission or
tool authority is not.

## Consequences

- A Planner `workspaceIntent` describes the requested effect and acceptance
  facts. It cannot remove `bash`, `edit`, `write` or another Executor tool.
- A normal Attempt receives the tools registered by its Executor. Only the
  Executor's explicit response-only entrypoint may request a reduced surface.
- Capability requests no longer wait for `ControlKernel.decidePermission`.
  User approval is an exact fact consumed by the Executor/Host capability
  policy; it does not authorize a Planner to widen a request.
- Work Graph visualization, parallel execution and model/task decomposition
  remain first-class product behavior.
- Durable coordination, Runtime enforcement and Harness execution are easier
  to test independently. A Kernel failure cannot masquerade as a missing shell
  permission.
- Native worktree execution remains a trusted Host process. Docker and nested
  sandboxes retain their existing enforcement guarantees; this ADR does not
  claim that a model process can enforce OS policy by itself.

## Migration

1. Completed: Executor-owned Pi/Harness tool registration; `workspaceAccess`
   no longer selects the tool list.
2. Completed: production capability requests bypass `ControlKernel` and use the
   Executor/Host policy path; old Kernel wiring remains a compatibility seam.
3. Next: move graph admission, frontier scheduling and Task lifecycle APIs from
   `ControlKernel` into an explicitly named Durable Task Coordinator while
   preserving event identities and recovery facts.
4. Later: remove permission snapshots/actions and Kernel permission replay code
   after all historical ledgers are outside the active recovery horizon.

This ADR does not authorize a second router, a second Agent Loop or a shortcut
that writes Task state from Planner/UI code.
