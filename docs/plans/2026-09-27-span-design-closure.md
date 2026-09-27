# Span design closure

- Plan date: 2026-09-27
- Completion date: 2026-09-27
- Status: implementation and local acceptance complete; replacement-key live acceptance pending
- Base: `feat/span-routing@3ef3986`
- Implementation commits: `0af3345`, `4190eea` (closing implementation commit)
- Scope: finish the approved Span-only design, including recovery without an attached client.

## Review findings and delivered behavior

The previous completion claim was too broad: the system callbacks still threw,
configuration pinning covered credentials but not every planning/admission seam,
and cancellation and duplicate-preparation races remained.

| Finding | Delivered behavior |
| --- | --- |
| System replan and merge replan required a client | Server injects a recovery adapter before account activation. A temporary validation-only Planner host reuses ConversationSession, existing validation, Span preparation and Kernel authorization. Ownership is checked against the durable Task. |
| Replans could use active configuration | Planner context, model/environment resolution, candidate construction, admission and Runtime resolve the pinned revision; startup loads snapshots for pending events and active graphs. |
| Pinned Planner resolution killed another running session | Each RPC run captures its own model/environment; resolving a historical revision no longer refreshes the shared supervisor. A concurrent two-revision regression reproduced the bug before the fix. |
| Concurrent preparation duplicated Span calls | Identical event IDs share preparation and retain the result until durable enqueue; changed identities are rejected. At most 64 outstanding prepared events are retained. Durable replan replay skips both Planner and Span. |
| A later Turn could revive an earlier cancelled proposal | Preparation captures its original signal and checks it across awaits, including early-return paths. Already-cancelled replans never start Planner or Span. |
| Shutdown was recorded as user cancellation | Explicit cancellation still cancels the generation request. Shutdown/disposal interruption leaves the durable application `applying` for recovery. Merge-replan publication counters advance after successful preparation. |
| Server queue was unbounded; late responses could survive timeout | Two physical request slots and at most 128 queued requests; expired/aborted waiters are removed. The caller meets its deadline even if a transport ignores abort, while that transport retains its physical slot until it settles. |
| Provider could read the Span internal reference | Schema rejects Provider references into the internal namespace, in addition to the existing Span literal-reference and Server checks. |
| Live smoke did not cover Kernel ordering/replay | `--integration` compares simple, complex, research and single-candidate workloads through the production adapter, Kernel and SQLite; reports order/latency/usage and checks replay adds no calls. Default mode remains the transport check. Untrusted model text and unknown usage fields are redacted. |

No new semantic router, authorization owner, persistence table, migration,
client surface or user billing stage was introduced. A crash before durable
enqueue may still repeat a paid API call; no exactly-once guarantee is claimed.
Historical configurations without `routing.span` retain their existing shape.

## Validation

These are separate runs with overlap, not additive coverage totals.

- Final focused host run: **16 files / 175 tests passed**.
- Broader account/execution/storage/kernel/routing/configuration/architecture and
  selected Session/E2E run: **142 files / 930 tests passed**, **1 failure** in the
  previously reproduced `configuration-module-boundary` baseline (Gateway
  imports storage types). This preceded the last Planner concurrency refinement;
  its affected seam was checked afterward.
- Planner supervisor plus detached host: **40 passed / 1 known baseline failure**
  (vendored Planner `dist/cli.js` absent; fallback executable expectation).
- Four slow Planner-to-Executor scenarios passed under the repository's default
  timeout, including exhausted-task replan. Their earlier run with a temporary
  30-second test timeout failed from timeout; that run is not counted as a
  product regression or a pass.
- Chrome settings E2E: **4 tests passed**, including key separation, clearing
  after save and retaining the stored Span key when disabled.
- Docker, Linux Node **22.23.2**, final sources: **9 files / 82 tests passed**,
  plus **1 pinned-Planner concurrency test passed** (39 unrelated tests excluded
  by the filter). Uses the locally cached `node:22-slim` base with installed
  Linux dependencies; temporary validation containers/image were removed.
- Root `npm run lint`, Web `tsc --noEmit`, full `npm run build` (including Web),
  and `git diff --check` passed.
- Integration smoke orchestration passed with intercepted HTTP and fake
  credentials. Recovery tests cover both new proposals through real
  ControlKernel/SQLite and replay without another Planner or Span call.

The exact repository `Dockerfile.test` build was attempted but failed while
fetching the Docker Hub token for `node:22.19.0-bookworm-slim`. The successful
cached-image run proves the selected Linux/SQLite seams; it is not an exact
replacement for that pinned-image build or the complete Docker suite.

No new full `npm test` run was performed. The earlier all-suite baseline with
11 failures is historical evidence, not the failure count of this round.

Local logs: `/tmp/span-closure-final-focused.log`,
`/tmp/span-closure-regressions.log`, `/tmp/span-closure-supervisor.log`,
`/tmp/span-closure-planning-default.log`, `/tmp/span-closure-browser-all.log`,
`/tmp/span-closure-docker-final.log`, `/tmp/span-closure-docker-build.log`,
`/tmp/span-closure-build-final.log`, `/tmp/span-closure-lint-final.log`.

## Outstanding acceptance and release work

- Provide a replacement OpenRouter key through advanced settings or the smoke's
  credential input, then run `npm run smoke:span-routing -- --integration`.
  The previously exposed key was not reused. Three scored samples call Span;
  the single-candidate sample and durable replay do not. Live service behavior,
  latency/cost and routing usefulness have not been re-established in this round.
- Re-run the exact pinned `Dockerfile.test` build when Docker Hub is reachable.
- Existing unrelated baseline failures remain. No push, merge or deployment was
  performed by this closure.
