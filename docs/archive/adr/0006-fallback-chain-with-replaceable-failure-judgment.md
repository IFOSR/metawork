---
status: superseded
superseded_by: ADR-0019, ADR-0020 and convergence-roadmap Phase 4
---

# Fallback chain with a replaceable failure-judgment layer

> Historical design input only. Adapters/Runtime normalize execution facts; Control Kernel owns retry, fallback and terminal-action policy. Raw error text is not the future Kernel Interface.

## Context

With `race_executors` abolished (ADR-0001), degraded execution relies on `fallbackChain`: when the primary executor fails, try the next, sequentially, until one succeeds or the chain is exhausted. But "failure" is not uniform — a failure caused by permissions, network, or timeout (force-majeure / environmental) is not the executor's fault, and retrying the *same task* on a *different same-class executor* will hit the same wall and waste tokens. Only failures rooted in executor capability (the executor couldn't do the work) justify trying a peer.

The existing code already classifies this — but partially, and with a misleading name. `error-utils.ts` exposes `isRecoverableExecutorFailure`, which returns `true` for network, permission, and timeout failures. `SessionExecutionCoordinator` already routes such failures to `markDispatchBlocked` (return to user) rather than retry. However, *non-recoverable* failures (capability shortfall) currently go to `parked` — there is no chain to try a peer. The user requires a judgment layer that decides, per failure, whether to retry-on-peer or return-to-user; the concrete judgment logic will eventually be authored as a skill, but must not block the chain now.

## Decision

1. **`fallbackChain` contains the same-class peer executors**, ordered by the three selection signals (ADR-0005). The primary is chosen first by those signals; the remaining same-class candidates form the chain in signal order.
2. **A failure-judgment layer sits before each chain step.** On primary failure, the layer classifies the failure into one of two outcomes:
   - *Force-majeure* (permission / network / timeout / environmental) → **do not try the chain**; return the failure to the user (block the task), as the code already does.
   - *Capability shortfall* (executor couldn't do the work) → **try the next executor** in `fallbackChain`.
   - If the chain is exhausted without success → return the failure to the user.
3. **The judgment layer is a replaceable interface, not a hardcoded function.** Its initial implementation reuses the existing `isRecoverableExecutorFailure` (force-majeure = recoverable; capability shortfall = non-recoverable). A dedicated failure-judgment skill will replace this implementation later; the interface (failure text in → {retry-peer | return-user} out) stays stable.

## Considered Options

- **A — reuse `isRecoverableExecutorFailure` as a fixed part of the chain.** Rejected as *the* design: it bakes the regex classifier permanently into the fallback path, leaving no seam for the skill the user plans to write.
- **B — build a new independent failure-judgment skill from scratch now.** Rejected: duplicates an existing, correct-enough classifier. Two judgment systems would coexist and drift.
- **C (chosen) — reuse now behind a replaceable interface.** Keeps the working classifier, avoids duplication, and reserves the seam the future skill needs.

## Consequences

- **Semantic trap to document:** `isRecoverableExecutorFailure`'s "recoverable" means *force-majeure / environmental* (retry-after-user-action makes sense), **not** "executor capability is recoverable." Force-majeure → return to user; capability shortfall → retry on peer. The name inverts intuition. The replaceable interface should be named for its decision (`shouldRetryOnPeer`), not inherited from the legacy term.
- The chain only tries *same-class* peers (ADR-0005 ordering). A misclassified capability class (wrong `CapabilityClass` assigned upstream) is **not** rescued by the chain — all same-class peers share the class limitation. That rescue belongs to the reviewer / user, not fallback. This keeps the chain's responsibility narrow.
- Two distinct decision moments now exist and must not be conflated: (a) *choosing* the next executor uses the three signals (LLM-decided, ADR-0005); (b) *deciding whether* to try the next uses the failure-judgment layer (regex now, skill later). Different inputs, different mechanisms.
- Chain exhaustion is a terminal failure → task returned to user. Not a defect; it is the deliberate end of the degraded path.
