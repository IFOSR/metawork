# Span live acceptance

- Date / completion date: 2026-09-27
- Status: live API, routing/replay and default-timeout acceptance passed; exact Dockerfile image build remains network-blocked
- Branch: `feat/span-routing`
- Closing implementation commit: `9a4f455`
- Authorization: the user explicitly approved use of the current OpenRouter key for validation. No replacement-key prerequisite remains.

## Live defect and correction

The first live integration run failed its three scoring scenarios with HTTP 400.
A minimal request isolated the provider contract: the System One endpoint requires `state` to be
a string, although the SDK accepts objects for other decision providers. Both
the production adapter and transport smoke had sent an object. The previous
HTTP mock accepted that invalid shape, so the earlier local acceptance missed it.

The HTTP regression now rejects object state and verifies that the serialized
state retains the task. Both transport and integration cases failed before the
fix and passed afterward. The production SDK boundary and transport smoke now
JSON-serialize state. The request budget includes the resulting JSON escaping;
internal candidate identity and Kernel observation contracts remain unchanged.

## Real service results

`npm run smoke:span-routing -- --integration` passed using the real API with the
current key. The three scored samples were accepted by ControlKernel and
persisted/replayed through SQLite. The single-candidate sample skipped scoring.

| Scenario | 10-second acceptance limit | Input tokens | Output tokens | Reported cost | Replay calls |
| --- | --- | --- | --- | --- | --- |
| Simple edit | advised, 5758 ms | 768 | 0 | 0 | 0 |
| Complex implementation | advised, 1282 ms | 779 | 0 | 0 | 0 |
| Research comparison | advised, 1433 ms | 776 | 0 | 0 | 0 |
| Single candidate | skipped, 0 ms | unavailable | unavailable | unavailable | 0 |

In the three scored samples, deterministic routing chose `model-fast`
(`gpt-5-mini`), while Span selected `model-deep` (`gpt-5`) for both eligible
AgentClasses. AgentClass order was unchanged. These results establish that the
live signal reaches authorization without widening candidates; they do not
establish better task outcomes or lower execution cost. Reported zero API cost
is the response from these calls, not a future pricing guarantee.

## Default timeout and credential-file path

A second integration run used the product default **3000 ms** deadline via
`SPAN_LIVE_DEFAULT_TIMEOUT=1`. The key was supplied through a temporary
mode-0600 credentials file in the `internal["routing-span"]` slot, with no key in
the Provider map. The temporary directory/file was removed after the run.
The fixture validates timeout fallback against the full deterministic binding
result and still requires successful scoring or the specific timeout reason;
HTTP/protocol errors cannot pass this acceptance mode.

| Scenario | Outcome | Elapsed | Replay calls |
| --- | --- | --- | --- |
| Simple edit | `span_timeout`; original deterministic bindings preserved | 3010 ms | 0 |
| Complex implementation | advised | 2236 ms | 0 |
| Research comparison | advised | 1817 ms | 0 |
| Single candidate | `single_candidate`; no API call | 0 ms | 0 |

Successful responses resolved to **`inception/mercury-decide-20260930`**. The timeout
returned no usage; no zero-cost claim is made for the interrupted request.
The default transport smoke also passed with the same temporary internal
credential source: 2244 ms, 317 input tokens, 0 output tokens, reported cost 0,
and two finite probabilities (0.828178 and 0.836666).

Keys were passed only through process environment or the temporary credential
file, not committed or printed. The user's installed configuration and Provider
credentials were not changed. Product users continue to enter their own keys
through advanced settings.

## Regression/build evidence

- Red: both new HTTP shape assertions failed against the previous code.
- Green: five focused files / **71 tests passed** (adapter, transport/integration
  smoke, preparation and Kernel paths).
- After adding default-timeout acceptance reporting: two files / **16 tests
  passed**. These overlap the preceding run and are not additive coverage.
- Root `npm run lint`, full `npm run build` including Web, and
  `git diff --check` passed.
- No new full-suite or browser run was needed for this transport-only fix.
  Previous results remain in [design closure](2026-09-27-span-design-closure.md).

Local safe evidence: `/tmp/span-live-acceptance-fixed.log`,
`/tmp/span-live-default-timeout.log`, `/tmp/span-live-transport-fixed.log`,
`/tmp/span-state-red.log`, `/tmp/span-state-green.log`,
`/tmp/span-live-harness-tests.log`, `/tmp/span-live-lint.log`,
`/tmp/span-live-build.log`.

## Remaining validation boundary

The exact `Dockerfile.test` build was retried. Docker Hub token retrieval for
`node:22.19.0-bookworm-slim` again timed out; a direct IPv4 check also failed.
The build never reached dependency installation or tests. No global network or
Docker configuration was changed. Evidence: `/tmp/span-live-docker-build.log`.

The earlier Linux Node 22.23.2 Docker run passed 82 targeted tests plus one
Planner concurrency regression before this wire-format correction. It is not
reported as an exact-image or post-correction Docker pass. Existing unrelated
baseline failures remain, and no push, merge or deployment was performed.
