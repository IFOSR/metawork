# Web Search Backend Replacement Plan (pi-research Executor)

- Date: 2026-09-04
- Status: Proposed — awaiting user review before implementation
- Trigger: research tasks stalled 60–92 s per web_search batch; the WeChat
  Channels task burned ~6.5 min in slow searches and finally hung on an
  unreachable backend.

## 1. Root cause (verified, not a guess)

The executor's `web_search` tool is the MetaWork-injected Pi extension
(`src/executor/pi-agent.ts` → `PI_WEB_EXTENSION_SOURCE`, emitted to
`metawork-web-tools.ts` in each attempt home). Current implementation:

- **Backend: DuckDuckGo HTML** (`https://html.duckduckgo.com/html/`) via curl
- **Timeout: 120 seconds** per call, no fallback backend
- Executed inside the attempt sandbox with the host network

Latency measurements from this machine (2026-09-04):

| Backend | Measured latency | Status |
|---|---|---|
| `html.duckduckgo.com` / `lite.duckduckgo.com` | **> 10 s, timeout** | unreachable/slow — matches the 60–92 s observed batches and the final hang |
| `www.bing.com/search` (HTML, UA + redirect follow) | **0.79 s**, 10 organic results (Zhihu/GitHub/CSDN on the exact Channels query) | excellent |
| `cn.bing.com` | 0.44 s | excellent |
| `www.baidu.com/s` | 0.28 s (302 → result page) | excellent, strong for Chinese queries |
| `api.tavily.com` | 1.8 s (API, needs key) | reachable |
| `open.bochaai.com` | 0.45 s (API, needs key) | reachable |
| `api.search.brave.com` | timeout | unreachable |

Note: the **Planner's** `web_search` (`planner-web-tools.ts`) already uses
`https://www.bing.com/search` with a 15 s timeout — which is why Planner
searches stayed fast while the executor's DuckDuckGo crawled.

## 2. Proposed design

### 2.1 Primary change: DuckDuckGo → Bing HTML (same shape as the Planner)

In `PI_WEB_EXTENSION_SOURCE` (`src/executor/pi-agent.ts`):

1. `web_search` hits `https://www.bing.com/search?q=<query>&count=<limit>`
   with a browser User-Agent, following redirects (max 3), parsing
   `li.b_algo` blocks (title/url/snippet) — reuse the proven parsing from
   `planner-web-tools.ts`.
2. Drop the DuckDuckGo URL-normalization (`duckduckgo.com/l/?uddg=`) and
   ad-filtering paths; Bing needs neither.
3. **Tighten the curl timeout from 120 s to 15 s** and set
   `--connect-timeout 5` so dead networks fail in seconds, letting the model
   reroute instead of hanging.
4. `web_fetch` keeps its current behavior but inherits the tighter timeouts.

### 2.2 Fallback chain: Bing → Baidu

Sequential fallback per query (only on hard failure/timeout, not on empty
results):

1. `www.bing.com/search` (primary — balanced quality for CN+EN)
2. `www.baidu.com/s` (fallback — fastest, strongest Chinese coverage;
   parse `result.c-container` blocks)

If both fail the tool returns a structured error to the model ("search
backends unreachable") in < 40 s total instead of hanging for 120 s.

### 2.3 Optional API tier (behind config, default off)

Add support for JSON API providers as a quality upgrade, selectable via
environment/config in the attempt payload:

- **Bocha AI Search** (`open.bochaai.com/v1/web-search`): domestic,
  AI-oriented, clean JSON, paid per call — best quality if budget allows
- **Tavily**: LLM-optimized results, free tier 1000 calls/month

Priority: `bocha|tavily (if configured) → bing → baidu`. This keeps the
zero-config default free while leaving a quality knob.

### 2.4 Guardrails that come along

- Per-attempt search budget (e.g. max 30 calls) to bound runaway research
- Result caching within the attempt (identical query → cached result) to
  stop duplicate burns
- Telemetry line in the tool result (`provider, elapsedMs, resultCount`)
  feeding the future L1 activity stream

## 3. Why not the alternatives

| Option | Verdict |
|---|---|
| SearXNG self-hosted on the Huoshan box | good but needs deployment + upstream engines are foreign/slow from CN; revisit only if HTML tier proves insufficient |
| Brave API | unreachable from this network |
| Bing official API | retired by Microsoft (Aug 2025) |
| Pure Baidu | fast but weaker for English/technical queries; kept as fallback |
| Keep DuckDuckGo | measured unreachable — non-starter |

## 4. Scope and validation

- Files: `src/executor/pi-agent.ts` (extension source), plus focused tests
  extending the existing pi-agent/pi-cli-driver test seam with fixture HTML
  for bing/baidu parsing and the fallback chain.
- Validation:
  1. Unit: parser fixtures (bing 10-result page, baidu page, empty/error
     pages), timeout paths (5 s connect / 15 s total), budget/cache rules.
  2. Live: re-run the Channels research task and compare — expectation is
     ~7× faster search phases (60–92 s → <10 s per batch) and no hangs.
- Rollout: default bing+baidu chain ships on; API tier documented, off.

## 5. Estimate

~0.5 day including tests; no schema/migration impact.
