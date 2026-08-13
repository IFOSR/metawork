# Future A2A Executor Transport Roadmap

- **Status**: Deferred
- **Date**: 2026-08-13
- **Depends on**: ADR-0029 (Executor Transport And A2A Boundary)
- **Parent plan**: `docs/plans/2026-08-11-metawork-server-upgrade-implementation-plan.md`

## Status

Remote (A2A) Executor transport is **deferred**. The current release keeps the
`ExecutorAdapter` authorized-attempt port transport-neutral and carries the full
authorization identity a future remote envelope needs, but ships no A2A adapter,
configuration variant, endpoint registry, discovery, authentication, streaming,
cancel, or artifact transport.

## Frozen Ownership Chain

```
Planner -> Kernel -> Runtime -> ExecutorAdapter -> transport
```

The remote endpoint is an execution target, not a scheduling or policy owner. A
future A2A transport cannot select models, AgentClasses, permission profiles,
retry, fallback, replan, or preemption. Runtime remains responsible for context
materialization, workspace checkpointing, resource lease lifecycle, artifact
intake, completion validation, and normalized observations.

## Authorization Identity Available At The Seam

The transport-neutral `ExecutorInput.executionBinding.authorization` already
carries, for every dispatched attempt:

- `attemptId`, `generationId`, `idempotencyKey`
- `configurationRevision`, `bindingFingerprint`
- authorized `agentClassRef`, `harnessRef`, `providerRef`, `modelRef`,
  `permissionProfileRef`

A future remote envelope must be built from this identity plus the
resource/capability grant and artifact provenance requirements that Runtime
materializes at dispatch time. The envelope must never widen authority beyond
what this identity already grants.

## Work Required Before A2A Can Ship

1. **Version negotiation** — capability and envelope version agreement between
   Runtime and a remote endpoint, with downgrade and mismatch rejection.
2. **Authentication and trust rotation** — endpoint authentication, key
   rotation, and revocation without weakening the configuration authority that
   ADR-0027 owns.
3. **Request idempotency** — idempotency-key semantics across retries and
   reconnects, keyed on the authorized binding fingerprint.
4. **Disconnect, poll, stream, cancel** — lifecycle for long-running remote
   attempts, including disconnect tolerance, poll/stream progress, and
   cancellation propagation.
5. **Uncertain outcomes** — normalization of lost-contact and ambiguous
   terminal states into Kernel-visible uncertainty, never into hidden retry or
   scheduling policy.
6. **Artifact integrity** — remote artifact provenance, hash verification, and
   intake into the existing evidence/artifact path.
7. **Remote permission and resource boundaries** — sandboxing, capability
   grants, and resource lease limits that match the local PermissionProfile
   semantics.
8. **Failure normalization** — mapping transport, authentication, and remote
   sandbox failures into the shared `KernelFailure` shape.

## Acceptance

An A2A implementation is acceptable only when all eight areas above are
specified, tested, and approved through a new ADR, and when it introduces no
transport-specific scheduler, router, retry engine, recovery workflow, health
policy, capacity policy, or permission policy. Only the composition root may
wire a concrete A2A adapter into the `ExecutorAdapter` port.
