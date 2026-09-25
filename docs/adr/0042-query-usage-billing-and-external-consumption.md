# ADR-0042: Query Usage Metering, Billing And External Consumption

- **Status:** Accepted
- **Date:** 2026-09-21
- **Scope:** Query-scoped usage attribution, metering spans and observations,
  immutable price versions, payer policy, per-Query final bills, Task/account
  rollups, and idempotent submission of a consumption intent to an independent
  third-party system
- **Amends:** ADR-0031 (adds read-only usage/billing query projection to the
  unified client Gateway command plane), ADR-0037 (keeps Conversation slots and
  account scheduling untouched; adds a residue fence and durable account wakeup
  to the existing scheduling path)
- **Preserves:** ADR-0011, ADR-0015, ADR-0020, ADR-0022, ADR-0023, ADR-0024,
  ADR-0025, ADR-0026, ADR-0032, ADR-0034, ADR-0036, ADR-0040, ADR-0041
- **Supersedes:** nothing
- **Related plan:** `docs/plans/2026-09-21-metacoin-query-billing-implementation-plan.md`
- **Related assessment:** `docs/plans/2026-09-21-multi-tenant-and-query-metering-assessment.md`
- **Governed by:** ADR-0020

## Context

MetaWork runs account-scoped Planner, Kernel and Executor work through the
unified Gateway. It can already run several Conversation-owned Tasks in
parallel (ADR-0037), and a single Task can accumulate multiple user requests,
automatic retries, fallbacks, replans and resumed execution segments.

Nothing in the current runtime attributes token, tool, image or execution
resource consumption to an accountable request, and there is no durable record
of what a request should cost. Commercial operation needs exactly that: a
per-Query accrual that is explainable by stage, distinguishable from verified
third-party deduction, and repeatable after a crash.

The commercial model — subscription converts to MetaCoin, `1 CNY = 1 MetaCoin`,
initial cost markup in the 30%–50% band — is already confirmed. Where the money
lives is not: an independent third-party system owns funded accounts, balances
and actual deduction. MetaWork must not become a payment or wallet product.

## Decision

1. **Query is the billing root; Task is only an aggregation dimension.**
   A Query is one semantic request accepted by the Server, or one explicit user
   action that starts a new execution segment. A Query is not a Task, not a
   Turn, and not a new scheduler state machine. A Query may have no Task at all
   (clarification, planning failure, explanation of an existing Task,
   control-only request) and may still accrue cost. Once a Kernel-authorized
   application fact exists, a Query is linked to at most one cost-bearing Task
   for the accrual period; that link may only move from `null` to one Task, and
   it never follows UI focus. `relatedTaskIds` expresses read-only references
   and is never a cost-allocation input.

2. **Attribution is persisted before the first chargeable call.**
   `query_usage_contexts` records the Query identity (scoped by account and
   ingress), the request/Turn identity it reuses, and the pinned price book,
   payer configuration and fee-policy versions. `execution_usage_contexts`
   persists the mapping from planner runs, generations, attempts and execution
   segments to the Query. Duplicate transport delivery of the same request key
   reuses the existing Query; identical text in a new request does not. A
   request key presented with a different payload is rejected rather than
   silently rebound.

3. **Metering collects facts; billing computes money; the third party holds
   funds.** Three orthogonal dimensions — `stage`
   (`intake/context/planning/execution/verification/delivery`), `reason`
   (`primary/retry/fallback/replan/compaction/merge_repair/system_probe`), and
   `resource`
   (`model_tokens/image/search/tool_request/compute/storage/network`) — are
   never summed into each other. An observation carries a stable source event
   key, source scope
   (`model_request | harness_turn | attempt | resource_allocation`), the
   Query/segment association, raw counters, unit, capture time, provider/model
   binding version, payer, and an integrity/quality marker. Exactly one
   authoritative coverage level is summed per covered range; parent rollups and
   child detail are never added together.

4. **Missing usage is not zero.** Quality is reported as
   `reported/estimated/unavailable` with coverage and missing counts. Estimates
   may inform progress and shadow accrual but are not a default charging basis.
   An uncollected counter never becomes `0` and never becomes a fabricated
   amount. Capability gaps are published as an explicit per-resource,
   per-harness capability matrix instead of implied precision.

5. **Payer is server-derived.** The payer of a model call is `platform`,
   `user_direct`, `system` or `unknown`, decided from trusted Server
   configuration or verifiable credential relationships — never from a model
   name, a Provider display name, or a client claim. `user_direct` model cost
   is excluded from the platform charging base; `system` background cost is
   never spread onto the last active Query; `unknown` keeps usage but stays out
   of the final chargeable total. Custom Providers remain supported and are
   never restricted or migrated for billing reasons.

6. **All accounting is exact.** `1 MetaCoin = 1_000_000 microCoin` and
   `1 CNY = 1_000_000_000 nanoCny`. Quantities and unit prices stay exact
   rationals until a Query total, which is rounded once, half-even, to integer
   microCoin. Stage-level display amounts are distributed from the finalized
   total with a deterministic largest-remainder method and stable ID ordering so
   that detail sums to the total. Cross-process big integers travel as decimal
   strings.

7. **A Query bill is a final, immutable accrual record, not a payment.**
   Local bill state is `collecting -> pending_reconciliation -> finalized`.
   Finalization requires that the request/segment ended, no active or uncertain
   chargeable call remains, attribution is settled, and usage plus a price and
   payer policy are present; Turn completion or Task terminal state is not
   sufficient. A missing item may be excluded only through an audited
   platform-absorb decision that keeps `coverage=incomplete` with a reason.
   Actual procurement cost is reconciled separately; late cost never silently
   tops up a bill — a correction references the original bill through
   `bill_adjustments`.

8. **Task and account rollups only sum assigned finalized Query amounts.**
   `TaskAssessedTotal(T) = SUM(finalized Query amounts assigned to T)`; it never
   re-prices history with current prices, never re-charges, and reports in-flight
   and pending-reconciliation amounts separately. Account rollups never add
   "Query detail" and "Task rollup" of the same Query twice.

9. **External consumption is at-least-once submission plus third-party
   idempotent application.** A finalized bill and its `consumption_outbox` row
   are written in one database transaction. The idempotency key is
   `sourceInstanceId + billId`; a digest over the normalized payload covers
   account, unit/currency, amount, version and attribution fields. The same key
   with a different amount or account is a conflict, never an overwrite. Network
   timeouts are `unknown` and are reconciled by querying the original key.
   `received` is not `confirmed`; `confirmed` requires an external entry id and
   an exactly matching applied amount. Explicit business rejection is recorded
   with its reason, never retried under a rotating key, and never re-executes
   the Task. MetaWork publishes the `ExternalConsumptionPort`; concrete protocol
   translation lives in `src/integrations/`.

10. **No local wallet, balance, top-up, refund or overdraft control.** MetaWork
    does not store balances, freeze funds, reserve budget, block admission for
    insufficient balance, or promise that insufficient balance prevents cost.
    Subscription, recharge, payment and refund stay entirely in the external
    system. Authorization, scheduling and recovery policy remain owned by the
    Kernel; the metering and billing modules must not add scheduling or
    admission behavior.

11. **Clients project, never compute.** `usage_billing_v1` is an optional
    capability advertised through the existing Gateway hello. Read-only
    projection queries (`get_query_bill`, `get_task_usage_summary`,
    `list_query_bills`, `get_usage_summary`) follow ADR-0041's read-only branch
    rules: no semantic mailbox, no Turn creation, connection-scoped responses,
    structured errors, authorization and pagination reuse. Web, TUI and Feishu
    all distinguish assessed, third-party-confirmed, pending-reconciliation and
    non-platform-payer cost. Taskless Queries are first-class. Clients never
    compute authoritative prices and never send a consumption charge. Outbound
    payloads contain no prompt text, hidden reasoning, Provider keys or
    confidential procurement prices.

12. **Export is gated on a trusted deployment boundary.** Local statistics that
    client or Executor code can rewrite are not a tamper-resistant charging
    credential. `export` may only be enabled where the trusted Server owns the
    metering source and the consumption credential, the Executor cannot read the
    consumption credential, and the third party provides stable idempotency,
    state query and sufficient amount precision. Otherwise the system stays in
    `observe` or `shadow`. Release proceeds
    `observe -> shadow -> export`; a missing third-party selection, credential,
    price book or reconciliation window does not block the first two stages.

13. **Reliability fixes that protect attribution are in scope; multi-tenancy is
    not.** Cleaning up slot/residue fences, durable account wakeups after
    cancellation, queue-limit enforcement and scheduling fairness stay within
    the existing Kernel authorization path. No shared multi-tenant Runtime, user
    registration, organization permissions, cluster scheduler, second semantic
    router, or re-execution of completed business work for accounting purposes.

## Consequences

- A new `src/metering/` domain owns Query context, observation normalization and
  coverage; a new `src/billing/` domain owns pricing, payer policy, bills,
  rollups and the external consumption application port. `src/integrations/`
  owns concrete third-party protocol adapters; `src/storage/` implements the
  ports they define. Dependency direction stays as ADR-0020 requires: the Kernel
  never depends on metering or billing, and metering never gains Planner storage
  or execution authority.
- Persistence reuses the existing Server SQLite database and migration flow, so
  upgrade/reopen, uniqueness, append-only and foreign-key constraints are
  validated in the same way as the rest of the schema. No separate commerce
  database or ledger is introduced.
- Historical Tasks and Turns without reliable usage are marked `historical
  unavailable`; they are never retroactively estimated or charged. Rollback
  first disables export; already-submitted bills and receipts are never deleted,
  and a backup restore must verify the stable `sourceInstanceId` before any new
  submission.
- Until the implementation plan's release gate completes, this ADR describes
  the accepted target. It does not claim that metering, billing or consumption
  export are delivered capabilities; current documents must label them as
  targets in the same way ADR-0027 through ADR-0030 do.
