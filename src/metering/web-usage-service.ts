/**
 * Billed web-tool usage projection.
 *
 * The Executor's `web_search`/`web_fetch` tools report their own metered
 * resource (`search` / `tool_request`) once per billed DeepSeek request. This
 * service turns those durable observations into the counts the account usage
 * view shows next to Token usage. It never returns a price: pricing stays a
 * separate decision from measured quantity.
 */

import type { MeteringStore } from './ports.js';

export interface WebUsageTotals {
  /** Billed DeepSeek search requests in the window. */
  readonly searchRequests: string;
  /** Billed DeepSeek page-extraction requests in the window. */
  readonly fetchRequests: string;
  readonly totalRequests: string;
  /** False when the store cannot answer the question (no resource summary). */
  readonly available: boolean;
}

export const EMPTY_WEB_USAGE: WebUsageTotals = Object.freeze({
  searchRequests: '0',
  fetchRequests: '0',
  totalRequests: '0',
  available: false,
});

export class WebUsageService {
  constructor(
    private readonly store: Pick<MeteringStore, 'summarizeResourceUsage'>,
  ) {}

  totals(input: { readonly accountId: string; readonly from: string; readonly to: string }): WebUsageTotals {
    const summarize = this.store.summarizeResourceUsage;
    if (typeof summarize !== 'function') return EMPTY_WEB_USAGE;
    const rows = summarize.call(this.store, {
      accountId: input.accountId,
      from: input.from,
      to: input.to,
      resources: ['search', 'tool_request'],
    });
    let search = 0n;
    let fetch = 0n;
    for (const row of rows) {
      if (row.resource === 'search') search += BigInt(row.quantity);
      else if (row.resource === 'tool_request') fetch += BigInt(row.quantity);
    }
    return Object.freeze({
      searchRequests: search.toString(),
      fetchRequests: fetch.toString(),
      totalRequests: (search + fetch).toString(),
      available: true,
    });
  }
}
