# ADR-0048: Official Account Payment Settlement And Refund Channel

- Status: Accepted
- Date: 2026-10-14
- Scope: official-server payment/refund channel only; local MetaWork clients stay read-only proxies
- Amends: [ADR-0047](0047-account-license-and-official-ai.md) (lifts its deferred-payment boundary; every other ADR-0047 decision, including in-memory sessions, online admission verification and the 24h active-work recheck, is unchanged)
- Design and acceptance record: [payment integration plan](../plans/2026-10-14-official-account-payment-integration.md)

## Context

ADR-0047 shipped accounts, licenses, server-defined plans and pending-payment
orders, and explicitly deferred the payment channel. Orders for monthly
(¥9.90) and annual (¥99.00) subscriptions could never be settled, so the
commercial loop stopped at "pending". The OPC Hub unified payment gateway now
provides WeChat Native scan payments with HMAC-signed APIs, an at-least-once
`PAYMENT.PAID` notification and a two-step refund flow with polled terminal
states.

## Decision

1. **Settlement authority stays server-side.** The official service is the
   merchant. The payment callback is the only authorization basis for
   entitlement; browser redirects and client self-reports never grant rights.
   Local MetaWork servers and Web remain passthrough and projection surfaces.
2. **Channel layer now, business layer later.** The refund channel (interfaces,
   records, terminal-state reconciliation, entitlement restoration kernel) is
   fully wired and tested through admin-only triggers over SSH loopback.
   Future self-service refunds only add a session route, eligibility policy and
   UI on the same kernel; refunds are never exposed to clients in this phase.
3. **Idempotent settlement in one immediate transaction.** Every callback and
   poll lands in one `BEGIN IMMEDIATE` settlement guarded by the attempt row's
   processed marker. Payment attempts (one row per gateway order per attempt)
   are kept as history so late callbacks for stale QR codes still settle the
   parent order; a second paid attempt on an already-paid order becomes a
   persisted `payment_incidents` row for manual refund and never grants rights
   twice.
4. **Amounts are exact integers end to end** (`9.90` ⇄ `990` cents). The order
   price decides settlement; the channel-discounted paid amount is archived
   only. Refunds always refund the full refundable amount
   (`channel_paid_amount ?? amount_cents − refunded_amount_cents`).
5. **Expiry semantics** follow the 2026-10-09 design: same-plan in-period
   renewal extends from `max(now, expiresAt)` via `addCalendarMonths`;
   expired accounts, trial upgrades and first purchases start at payment
   confirmation. A trial's remaining days are superseded when a paid plan
   activates. A revoked (not disabled) account may resubscribe.
6. **Refund entitlement restoration** is an append-only rollback: the refund
   that anchors the current effective license revision appends a copy of the
   previous revision (or a `revoked` revision when none exists) and only then
   marks the order `refunded`. Refunds of duplicate attempts or behind-newer-
   revision anchors keep rights and order status untouched and record
   `manual_required`. Failed refunds are terminal audit records; retries use a
   new idempotency key with a retry sequence.
7. **Refunds are admin-only** over SSH loopback with the existing admin token
   guard, all endpoints POST, with no time window; WeChat-side staleness
   limits may still reject and fall to manual handling.
8. **Real money that cannot settle never stays silent.** Unknown gateway
   orders, amounts outside the contract, disabled-account payments,
   post-close arrivals that cannot settle, duplicate payments, observed
   external refunds and a perpetual plan granted between order placement and
   payment (a free entitlement conflicting with real money) persist as
   `payment_incidents` for manual reconciliation.
9. **The transaction never performs network I/O.** Sibling-attempt closure
   happens after commit; a close that raced a payment re-enters the idempotent
   settlement independently. Hub queries from polling are throttled per order
   (5 s minimum) because the notification is the primary settlement path.
10. **Graceful degradation.** Without `PAYMENT_HUB_*` configuration the
    service behaves exactly as before payment integration and answers
    `payment_unavailable`; deployment may ship code before credentials.

## v1 boundary semantics

- Manual renewal only; no auto-deduction (delegated WeChat deduction needs a
  separate OPC Hub product and merchant qualification).
- Cross-plan changes stay blocked while a plan is active; switching happens
  after expiry (existing `active_plan_conflict` semantics).
- Degradation timing after refund: every new productive request verifies
  online, so the next request is blocked immediately; the 24-hour active-work
  recheck only paces already-running work, identical to expiry and revocation.
- Channel-side query throttling and per-IP limits remain in force for
  client-facing routes; gateway notifications are exempt from the IP limiter.

## Consequences

- The official service owns three new tables (`order_payments` attempt
  history, `order_refunds`, `payment_incidents`); existing tables are only
  appended to, so deployed databases upgrade on restart without ALTERs.
- Client surfaces gain pay/poll/list passthrough routes and a QR dialog;
  refund UI is deliberately absent.
- `official-server/README.md` documents the implemented settlement contract
  and the admin commands (`orders`, `refund`, `refund-status`, `close-order`,
  `incidents`).
- ADR-0042 Query usage billing remains separate; the MetaCoin bill is local
  cost accounting and external consumption export stays release-gated.
