# Query Usage And Billing Operations

This note is the operational companion to
[ADR-0042](../adr/0042-query-usage-billing-and-external-consumption.md) and the
[2026-09-21 implementation plan](../plans/2026-09-21-metacoin-query-billing-implementation-plan.md).
It records what is delivered, what each release stage means, how to run it, and
which limits must stay visible to operators.

## Current delivery status

Delivered on 2026-09-21 as the metering/billing foundation, with release stages
still gated:

| Area | Status |
| --- | --- |
| Exact money, price versions, payer and fee policy (`src/billing/money.ts`, `pricing.ts`, `cost-policy.ts`) | Delivered |
| Query attribution and execution-segment persistence (`src/metering/query-context-service.ts`, `src/metering/ports.ts`) | Delivered |
| Usage normalization, deduplication and coverage projection (`src/metering/usage-normalizer.ts`, `coverage-projector.ts`) | Delivered |
| Final immutable Query bills, stage lines, Task/account rollups, bill adjustments (`src/billing/query-bill-service.ts`, `bill-query-service.ts`, `bill-adjustment-service.ts`) | Delivered (local / shadow) |
| External consumption domain port, outbox, idempotent export and reconciliation (`src/billing/consumption-*.ts`, `src/integrations/external-consumption-client.ts`) | Port + fake server delivered; production export **not enabled** |
| SQLite schema 41 (`src/storage/billing-schema.ts`, `src/storage/*-repo.ts`) | Delivered |
| Unified Task residue reader and slot-cleanup fence (`src/execution/task-residue-reader.ts`, `task-state-reconciler.ts`) | Delivered |
| Harness/Planner/Executor usage adapter wiring | Delivered at source seams; unsupported or absent provider usage remains explicitly unavailable |
| Gateway `usage_billing_v1` capability and Web/TUI/Feishu projections | Delivered as read-only Server projections; external export remains gated |
| Visible billing user projection: three-state status, stable diagnostics, per-Turn bill card, Web billing page (`src/billing/bill-query-service.ts`, `src/management/web-gateway-session-runtime.ts`, `web/src/components/TurnBillCard.tsx`, `BillingView.tsx`) | Delivered on 2026-09-22; every non-system Turn shows a bill card, missing usage shows 待确认 with a diagnostic code |
| Account queue/fairness/wakeup closure (plan Tasks 2–3 remainder, S1/S2/S3/S4/S5/S6) | Delivered through durable promotion/recovery paths and residue fencing; Docker restart evidence remains environment-gated |

The production adapter seams are wired, but the capability rows below remain
unmeasured until a provider reports real usage. A deployment without reported
usage must run in `observe` at most: bills stay `pending_reconciliation` with
`no_usage_observed`, which is the intended honest result. Do not treat missing
provider evidence as zero usage.

## Visible billing user projection

Since 2026-09-22 the billing surface separates the internal state machine from
what users see. Internal states (`collecting`, `pending_reconciliation`,
`finalized`, external receipt states) stay Server-side and in the expandable
diagnostic detail; users see at most three statuses:

| User status | Meaning | Headline |
| --- | --- | --- |
| `已计费` (`billed`) | Finalized bill with a positive amount | `本次费用：X MetaCoin` |
| `待确认` (`unconfirmed`) | Request finished but metering/billing facts are missing | `费用暂时无法确认` |
| `无费用` (`no_charge`) | Finalized bill with zero chargeable amount | `本次无费用` |

Stable diagnostic codes (`src/billing/bill-query-service.ts`):

| Code | User explanation |
| --- | --- |
| `no_usage_observed` | Provider 未返回可验证的用量数据 |
| `provider_usage_unavailable` | 当前 Provider 不提供用量数据 |
| `usage_parser_no_match` | 收到了 Provider 输出，但没有匹配到 usage 格式 |
| `query_not_finalized` | 请求仍在等待计量收束 |
| `missing_price_book` | 当前请求缺少有效价格规则 |
| `missing_price_rule` | 已记录 Token，但没有匹配到该 Provider/Model 的输入或输出单价 |
| `payer_unknown` | 已记录 Token，但没有确认本次调用由谁承担费用 |
| `missing_billing_projection` | 账单事实存在，但页面投影暂时不可用 |
| `historical_unavailable` | 历史任务没有足够事实，无法安全补算 |
| `external_consumption_disabled` | 本地账单已生成，但外部消费提交未启用 |

Delivery rules:

- Every non-system Web Turn renders a bill card after the final answer, even
  without an amount (`TurnBillUserView` from `getTurnBillUserView`). Missing
  amounts show `暂无法计算` plus the diagnostic message; unknown cost is never
  zeroed.
- The MetaWork TUI Task Dashboard consumes the same three-state view: the
  Gateway `get_query_bill_for_turn` read-only query publishes
  `{ turnId, turnBill: TurnBillUserView }` on the connection stream (never a
  404 while the bill record does not exist yet), and the panel renders the
  status, MetaCoin amount and per-stage/model token usage from
  `stageBreakdown`. A settled Turn still shows `待确认` briefly; the client
  re-queries with bounded backoff until the final amount arrives.
- `enrichTurn` re-projects billing per Turn from durable facts on every history
  read; stale persisted `queryBill` values are replaced, never trusted.
- The Web billing tab (`/api/billing/records`, `/api/billing/tasks/:taskId`)
  lists history with time, request summary, status, amount and Task; amounts
  and status always come from the Server projection, never client math.
- A Task with no Query facts shows `历史任务未建立计量记录`; amounts are never
  back-filled retroactively. Finalized bills are immutable against late usage.
- `external_consumption_disabled` is informational: local bills stay `已计费`
  while export remains off.
- At Server startup, explicit `METAWORK_BILLING_PRICE_BOOK_JSON` takes
  precedence. Otherwise the Server builds a versioned price book from the
  active Model Profile's `costInputPerMillion` and `costOutputPerMillion`
  fields, scoped by Provider and model ID. A model without explicit prices
  remains `待确认`; its price is never inferred from the model name.
- The Web Settings model list exposes these fields as `CNY / 1M tokens`.
  Saving a changed price creates a new configuration revision; restart the
  Server before creating new chargeable Queries. Existing Queries keep their
  original price-book version and are not silently repriced.
- Each bill projection also exposes a stage/model breakdown. `planning` is
  shown as `Planner` and `execution` as `Executor`, with input/output/cache
  token counts, Agent/Provider/Model identity, and the confirmed amount for
  that group. A Query may remain `待确认` while these already confirmed
  groups are visible; an unresolved non-model resource must not hide model
  usage.
- `cache_read`, `cache_write`, and reasoning counters are retained as
  observable token details but are subsets of input/output and are not
  independently priced. Zero-quantity counters never create
  `missing_price_rule`. Server startup retries non-finalized bills so
  historical bills written by the older parser can settle after this
  compatibility fix; finalized history remains immutable.

## Release stages

Run stages in order. A later stage requires every earlier stage's exit criteria.

### 1. observe — collect usage and coverage only

- Goal: record what each source actually reports, with explicit quality and
  coverage, and publish the real granularity per harness.
- Entry criteria: schema 41 is present; `usage_normalization_issues` is empty
  apart from known `unsupported_resource` entries.
- Exit criteria: at least one adapter emits `reported` observations for a full
  Planner turn and a full Executor attempt, and the per-resource capability
  matrix below is filled with measured, not assumed, granularity.
- Monitor: `usage_observations` count per Query, `unavailable` ratio,
  `duplicate_event` and `counter_reset` issues.

### 2. shadow — generate bills, never submit

- Goal: validate prices, payer classification, stage distribution, platform
  absorption and rollups without contacting any third party.
- Entry criteria: observe exit criteria met; a price book version exists with a
  published markup inside the 30%–50% band.
- Exit criteria: an operator review of sampled bills confirms that
  `BillableBase`, stage lines (summing to the total), `payer=user_direct`
  exclusion, `payer=system` absorption and platform-defect absorption all match
  intent; `pending_reconciliation` reasons are explainable.
- `consumption_outbox` rows are not created while export is disabled, so shadow
  runs leave no submission intent behind.

### 3. export — submit consumption intents

Enable `export` only when **all** of the following hold:

1. A trusted third-party system is selected and its test environment confirmed
   for idempotency retention, amount precision and status query.
2. `billing_source_instance` holds the durable instance identity and the
   deployment can prove backup/restore does not create a second sender.
3. A trusted `externalAccountRef` mapping is configured server-side; clients
   cannot choose the charged account.
4. The consumption credential lives in the existing SecretStore and is not
   readable by Executor work.
5. The production deployment boundary prevents untrusted work code from
   rewriting the local metering facts.
6. Restart and duplicate-delivery drills (below) pass.

Explicitly excluded from every stage: local wallet, balance, top-up, payment,
refund, fund freeze and balance-based admission. MetaWork never blocks work for
insufficient balance and never promises that it cannot overspend.

## Capability matrix

Fill this from measurements. Values are `reported | estimated | unavailable`,
plus the coverage scope actually used.

| Source | Scope | Granularity | Status |
| --- | --- | --- | --- |
| Planner RPC turns (`src/planning/`) | `model_request` | per model call | Reported when Provider returns usage |
| Planner compaction / hidden calls | `model_request` | per call | Not wired |
| Pi executor (`pi-cli-driver`) | `harness_turn` | per turn | Reported when Provider returns usage |
| Codex executor (`codex-cli-driver`) | `harness_turn` | per turn | Reported when Provider returns usage |
| Image API (`image-api-*`) | `resource_allocation` | per image | Not wired |
| Execution resources (compute/storage/network) | `resource_allocation` | per allocation | Not wired |
| Tool requests | `tool_request` | per request | Not wired |

Until a row is measured, that resource is `unavailable`; it is never reported as
`0`, and the resulting bill stays `pending_reconciliation`.

## Price Configuration

Token counts alone do not determine a fee. A formal fee also needs a trusted
input/output price for the exact Provider/model and the active fee policy.
Configure those values in Web Settings under `设置 → 模型列表`. The values are
provider currency per one million tokens, for example `1.25` means `1.25 CNY /
1M input tokens`; it is not a MetaCoin amount.

The default payer for configured Provider credentials is `platform`; no
environment variable is required for the normal MetaWork deployment. Use an
override only when the credentials are verifiably paid by another party:

```bash
# Optional override:
export METAWORK_BILLING_DEFAULT_PAYER=user_direct
```

Use `user_direct` only when the Provider account is verifiably paid directly by
the user; those model costs are recorded but are not added to the platform
chargeable bill. Use `unknown` explicitly only when the payer is genuinely
undetermined; that keeps the Token facts but leaves the formal amount as
`待确认`.

After saving and activating the configuration:

```text
stop Server -> npm run build -> npm run setup:native -> metawork server start
```

The next Query is pinned to the generated `config:<configurationRevision>`
price-book version. Historical `待确认` Queries remain visible with
`missing_price_book`; they are not retroactively recalculated because that
would change the accepted pricing contract.

For a live installation, verify the Server loaded the new contract before
testing in the UI:

```bash
# Only needed when overriding the default:
export METAWORK_BILLING_DEFAULT_PAYER=user_direct
metawork server restart
sqlite3 ~/.metawork/accounts/local-default/data/anyfusion.db \
  "select price_book_version, fee_policy_version from billing_price_versions order by created_at desc limit 1;"
sqlite3 ~/.metawork/accounts/local-default/data/anyfusion.db \
  "select query_id, price_book_version, payer_policy_version from query_usage_contexts order by accepted_at desc limit 5;"
```

The first query must show `config:<revision>`. A newly created Query must not
show `unconfigured`; if it does, the client is still connected to an older
Server process or the current configuration has no model prices. `payer_policy`
is a policy version, not the actual payer; the actual usage rows must show
`payer=platform` for a platform-funded Provider. Existing Query rows are
immutable and are expected to retain their old `unconfigured` version.

## Operating rules

### Query attribution

- A Query context is persisted before the first chargeable call and is scoped by
  `(account_id, ingress, request_key)`. A replayed request key with the same
  payload digest reuses the Query; a different payload is rejected.
- A Query links to at most one cost-bearing Task, only from an authorized
  Kernel application or an authorized execution-segment fact. A later
  conflicting link is a `different_cost_task` conflict, never a rebind.
- Taskless Queries are normal. `/status`, cancel, history replay and reconnect
  create no Query and no charge.

### Missing usage and platform absorption

- Missing usage stays `unavailable` and produces `pending_reconciliation`.
- Finalizing an incomplete bill requires an audited `PlatformAbsorptionDecision`
  (`reason`, `authorizedBy`, `decidedAt`, `missingCategories`). The bill keeps
  `coverage=incomplete` and its coverage note; unknown cost is never zeroed.
- Absorbed categories cover platform defects, `system` background work and
  `user_direct` provider cost. `user_direct` model cost never enters the
  chargeable base, but MetaWork-provided execution resources with a published
  price still do.

### Prices and payer bindings

- Price books are immutable and versioned. Each Query pins
  `price_book_version`, `fee_policy_version` and `payer_policy_version` at
  acceptance time; automatic retries reuse them, and history is never
  re-priced.
- Changing a Provider, price book or external account binding only affects new
  Queries.
- A Query accepted while the payer is `unknown` remains pending; changing the
  environment variable does not silently re-price or rewrite that historical
  Query.
- `1 MetaCoin = 1_000_000 microCoin`; `1 CNY = 1_000_000_000 nanoCny`. Do not
  introduce a settlement step that rounds per-event or per-stage.

### External submission

- Submit `sourceInstanceId + billId` once per final bill. The payload digest
  covers account, unit, amount, version and attribution.
- `received` is not a deduction. Only an `applied` result with an external entry
  id and an exactly matching amount sets `confirmed`.
- Timeouts are `unknown`: query the original key. Never mint a new `billId`.
- Explicit business rejections (including insufficient funds) are recorded with
  their reason and are not retried under a rotating key. They never roll back a
  Task, never re-execute work and never change a finalized bill.
- Amount or digest mismatches go to manual review (`manual_review:*` in
  `consumption_outbox.last_error`).

### Rollback, backup and restore

- Roll back by disabling export first; keep the outbox, bills and receipts.
  Already-submitted bills are never deleted.
- Older builds that do not understand schema 41 must take the verified
  compatible path, not a table drop.
- Before restoring a backup, verify `billing_source_instance` matches the
  previous sender. If integrity cannot be proven, keep export off.

### Monitoring

Alert on: usage `unavailable` ratio, `pending_reconciliation` age,
`not_exported` backlog, `unknown` receipts, `manual_review:*` errors, idempotency
conflicts, and amount mismatches. Final-bill count is not a correctness signal.

## Running the validation

```bash
npm run lint
npx vitest run tests/billing tests/metering tests/session/query-usage-attribution.test.ts
npx vitest run tests/acceptance/query-billing-lifecycle.test.ts
npx vitest run tests/execution/task-slot-cleanup-fence.test.ts
npx vitest run tests/storage/migrations.test.ts
npm test -- tests/kernel/control-kernel.test.ts tests/kernel/task-scheduler.test.ts \
  tests/execution/attempt-supervisor.test.ts tests/execution/task-cancellation-coordinator.test.ts \
  tests/execution/task-state-reconciler.test.ts tests/execution/cancellation-trace.test.ts \
  tests/account/account-startup-recovery-service.test.ts
docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test
```

On 2026-09-22 the Docker command was attempted with Docker Desktop
29.2.1/4.61.0, but the build could not fetch the base-image authorization
token from `auth.docker.io` before the network deadline. No Docker result is
claimed from that attempt; local SQLite/Vitest smoke remains the available
validation in this environment.

Defaults use the in-process fake consumption server and fake Providers; they
spend no real resources. Real model calls and real third-party production calls
require separate authorization.

## Restart and duplicate-delivery drill

Before enabling export:

1. Finalize an exportable bill, stop the process before any submission, restart,
   and confirm the same `sourceInstanceId + billId` key is used.
2. Simulate a lost response after the third party applied the bill, restart, and
   confirm reconciliation marks it `confirmed` without a second application.
3. Simulate a duplicate submission of the same key and confirm the third party
   returns the original application result.
4. Simulate an explicit rejection and confirm no key rotation or Task change.
5. Simulate restoring an older database and confirm export refuses to start
   until the instance identity is verified.
