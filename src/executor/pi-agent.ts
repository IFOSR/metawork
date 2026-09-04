// Holds the generated Pi web-tools extension source used by the sandboxed Pi attempt image.
export const PI_WEB_EXTENSION_SOURCE = String.raw`
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const SEARCH_CONNECT_TIMEOUT_S = "5";
const SEARCH_TOTAL_TIMEOUT_S = "15";
const FETCH_TOTAL_TIMEOUT_S = "30";
const MAX_SEARCH_CALLS_PER_ATTEMPT = 30;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function runCurl(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "curl",
      args,
      {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(value: string): string {
  return htmlDecode(value.replace(new RegExp("<script[\\s\\S]*?<\\/script>", "gi"), " ")
    .replace(new RegExp("<style[\\s\\S]*?<\\/style>", "gi"), " ")
    .replace(new RegExp("<[^>]*>", "g"), " ")
    .replace(new RegExp("\\s+", "g"), " ")
    .trim());
}


type SearchResult = {
  title: string;
  url: string;
  description: string;
  position: number;
};


function parseBing(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\\s\\S]*?)<\\/li>/gi;
  for (const match of html.matchAll(blockPattern)) {
    if (results.length >= limit) break;
    const block = match[1];
    const result = block.match(/<h2[^>]*>[\\s\\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/i);
    if (!result) continue;
    const url = htmlDecode(result[1]);
    if (!/^https?:\\/\\//iu.test(url)) continue;
    const snippet = block.match(/<p[^>]*>([\\s\\S]*?)<\\/p>/i);
    results.push({
      title: stripHtml(result[2]),
      url,
      description: snippet ? stripHtml(snippet[1]) : "",
      position: results.length + 1,
    });
  }
  return results;
}

function parseBaidu(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<div[^>]+class=["'][^"']*result[^"']*c-container[^"']*["'][^>]*>([\\s\\S]*?)<h3[^>]*>[\\s\\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  for (const match of html.matchAll(blockPattern)) {
    if (results.length >= limit) break;
    const url = htmlDecode(match[2]);
    if (!/^https?:\\/\\//iu.test(url)) continue;
    results.push({
      title: stripHtml(match[3]),
      url,
      description: "",
      position: results.length + 1,
    });
  }
  return results;
}

class SearchBackendError extends Error {}

const searchCallCount = { count: 0 };
const searchCache = new Map<string, { web: SearchResult[]; provider: string; elapsedMs: number }>();

async function searchPublicWeb(query: string, limit: number, signal?: AbortSignal): Promise<{
  web: SearchResult[];
  provider: string;
  elapsedMs: number;
}> {
  const cacheKey = JSON.stringify([query, limit]);
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const request = async (url: string, queryParam: string): Promise<string> => {
    try {
      return await runCurl([
        "-L",
        "--silent",
        "--show-error",
        "--get",
        "--data-urlencode",
        ` + "`${queryParam}=${query}`" + `,
        "--connect-timeout",
        SEARCH_CONNECT_TIMEOUT_S,
        "--max-time",
        SEARCH_TOTAL_TIMEOUT_S,
        "-A",
        BROWSER_UA,
        url,
      ], undefined, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SearchBackendError((error as Error).message);
    }
  };

  const startedAt = Date.now();
  const failures: string[] = [];

  let html = "";
  try {
    html = await request(` + "`https://www.bing.com/search?count=${Math.max(limit, 10)}&mkt=zh-CN`" + `, "q");
  } catch (error) {
    failures.push(` + "`bing: ${(error as Error).message}`" + `);
  }
  let web = html ? parseBing(html, limit) : [];
  if (web.length > 0) {
    const outcome = { web, provider: "bing-html-curl", elapsedMs: Date.now() - startedAt };
    searchCache.set(cacheKey, outcome);
    return outcome;
  }
  if (html && web.length === 0) failures.push("bing: no parseable results");

  try {
    html = await request("https://www.baidu.com/s", "wd");
  } catch (error) {
    failures.push(` + "`baidu: ${(error as Error).message}`" + `);
    html = "";
  }
  web = html ? parseBaidu(html, limit) : [];
  if (web.length > 0) {
    const outcome = { web, provider: "baidu-html-curl", elapsedMs: Date.now() - startedAt };
    searchCache.set(cacheKey, outcome);
    return outcome;
  }
  if (html && web.length === 0) failures.push("baidu: no parseable results");

  throw new SearchBackendError(
    "网络不可用：搜索后端（Bing、百度）均无法访问。" + (failures.length > 0 ? " 原因: " + failures.join("; ") : ""),
  );
}

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: "Search the public web. Uses curl so proxy environment variables such as HTTP_PROXY/HTTPS_PROXY are honored.",
  promptSnippet: "web_search(query, limit): search the public web and return titles, URLs, and snippets.",
  promptGuidelines: [
    "Use web_search for current, online, source-backed, market, company, product, and research tasks.",
    "Use specific queries. Prefer limit 3-10 unless broad coverage is required.",
    "Use web_fetch on important result URLs before making source-backed claims.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Search query." }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results. Defaults to 5." })),
  }),
  async execute(_toolCallId, params, signal) {
    const limit = Math.min(Math.max(Number(params.limit ?? 5) || 5, 1), 20);
    if (searchCallCount.count >= MAX_SEARCH_CALLS_PER_ATTEMPT) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: ` + "`本次执行的搜索次数已达上限（${MAX_SEARCH_CALLS_PER_ATTEMPT} 次）。请基于已获取的信息继续完成任务。`" + `,
          }, null, 2),
        }],
        details: { query: params.query, limit, budgetExhausted: true },
      };
    }
    searchCallCount.count += 1;
    try {
      const { web, provider, elapsedMs } = await searchPublicWeb(String(params.query), limit, signal);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: web.length > 0,
            data: { web },
            error: web.length > 0 ? undefined : "No parseable search results returned.",
            provider,
            elapsedMs,
          }, null, 2),
        }],
        details: { provider, query: params.query, limit, elapsedMs, resultCount: web.length },
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: (error as Error).message,
          }, null, 2),
        }],
        details: { query: params.query, limit, failed: true },
      };
    }
  },
});

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch a public webpage and return readable text. Uses curl and honors proxy environment variables.",
  promptSnippet: "web_fetch(url): fetch a webpage and return title plus readable text excerpt.",
  promptGuidelines: [
    "Use web_fetch to inspect important search results before citing or relying on them.",
    "Prefer official or primary sources when available.",
  ],
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch." }),
  }),
  async execute(_toolCallId, params, signal) {
    const rawUrl = String(params.url);
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only http/https URLs can be fetched.");
    }
    const html = await runCurl([
      "-L",
      "--silent",
      "--show-error",
      "--connect-timeout",
      SEARCH_CONNECT_TIMEOUT_S,
      "--max-time",
      FETCH_TOTAL_TIMEOUT_S,
      "-A",
      BROWSER_UA,
      rawUrl,
    ], undefined, signal);
    const title = html.match(new RegExp("<title[^>]*>([\\s\\S]*?)<\\/title>", "i"))?.[1];
    const text = stripHtml(html).slice(0, 12000);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: text.length > 0,
          url: rawUrl,
          title: title ? stripHtml(title) : undefined,
          text,
        }, null, 2),
      }],
      details: { provider: "curl", url: rawUrl },
    };
  },
});

async function callEvidence(operation: string, input: Record<string, unknown>) {
  const url = process.env.METACLAW_EVIDENCE_JSON_URL;
  const token = process.env.METACLAW_EVIDENCE_TOKEN;
  if (!url || !token) throw new Error("Execution evidence capability is unavailable for this attempt.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "authorization": "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ operation, input }),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(payload);
  return { content: [{ type: "text", text: payload }], details: { operation } };
}

const evidenceListTool = defineTool({
  name: "evidence_list",
  label: "Task Evidence List",
  description: "List user evidence authorized for this Task and attempt.",
  parameters: Type.Object({
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  }),
  async execute(_toolCallId, params) { return callEvidence("list", params); },
});

const evidenceSearchTool = defineTool({
  name: "evidence_search",
  label: "Task Evidence Search",
  description: "Search user evidence authorized for this Task and attempt.",
  parameters: Type.Object({
    query: Type.String(),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  }),
  async execute(_toolCallId, params) { return callEvidence("search", params); },
});

const evidenceGetTool = defineTool({
  name: "evidence_get",
  label: "Task Evidence Get",
  description: "Read an authorized evidence item in bounded chunks.",
  parameters: Type.Object({
    evidenceId: Type.String(),
    offset: Type.Optional(Type.Number()),
  }),
  async execute(_toolCallId, params) { return callEvidence("get", params); },
});

const resultReferenceListTool = defineTool({
  name: "result_reference_list",
  label: "Upstream Result References",
  description: "List full upstream results authorized for this direct dependency edge and attempt.",
  parameters: Type.Object({}),
  async execute(_toolCallId, params) { return callEvidence("result_reference_list", params); },
});

const resultReferenceGetTool = defineTool({
  name: "result_reference_get",
  label: "Upstream Result Get",
  description: "Read one authorized upstream ResultReference in bounded UTF-8 chunks.",
  parameters: Type.Object({
    referenceId: Type.String(),
    offset: Type.Optional(Type.Number()),
  }),
  async execute(_toolCallId, params) { return callEvidence("result_reference_get", params); },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  pi.registerTool(evidenceListTool);
  pi.registerTool(evidenceSearchTool);
  pi.registerTool(evidenceGetTool);
  pi.registerTool(resultReferenceListTool);
  pi.registerTool(resultReferenceGetTool);
}
`;
