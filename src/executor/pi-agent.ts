// Holds the generated Pi web-tools extension source used by the sandboxed Pi attempt image.
export const PI_WEB_EXTENSION_SOURCE = String.raw`
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

// File-tool capture channel: the Executor's own writes are recorded beside the
// attempt home so the Runtime can attribute changes even without Git.
// The extension is also loaded by lightweight Pi test/runtime hosts that do
// not expose Node's filesystem modules. Capture is best-effort observation;
// keep the extension usable when that optional seam is unavailable.
const optionalFs = (() => {
  try {
    return require("node:fs") as typeof import("node:fs");
  } catch {
    return null;
  }
})();
const optionalCrypto = (() => {
  try {
    return require("node:crypto") as typeof import("node:crypto");
  } catch {
    return null;
  }
})();
const optionalJoin = (() => {
  try {
    return (require("node:path") as typeof import("node:path")).join;
  } catch {
    return null;
  }
})();
const WORKSPACE_CAPTURE_FILE = optionalJoin
  ? optionalJoin(process.env.HOME ?? ".", ".metaclaw-workspace-captures.jsonl")
  : null;
const CAPTURED_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

function captureToolWrite(phase: "before" | "after", toolName: string, input: unknown): void {
  if (!optionalFs || !WORKSPACE_CAPTURE_FILE) return;
  if (!CAPTURED_TOOLS.has(toolName)) return;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : record.file_path;
  if (typeof path !== "string" || !path) return;
  let hash: string | null = null;
  let size: number | null = null;
  try {
    const bytes = optionalFs.readFileSync(path);
    hash = optionalCrypto?.createHash("sha256").update(bytes).digest("hex") ?? null;
    size = bytes.length;
  } catch {
    // A missing file before the write is a creation, not a capture failure.
  }
  try {
    optionalFs.mkdirSync(process.env.HOME ?? ".", { recursive: true });
    optionalFs.appendFileSync(WORKSPACE_CAPTURE_FILE, JSON.stringify({ phase, tool: toolName, path, hash, size, at: new Date().toISOString() }) + "\n");
  } catch {
    // Capture is observation only; never fail the tool call.
  }
}

const SEARCH_CONNECT_TIMEOUT_S = "5";
const SEARCH_TOTAL_TIMEOUT_S = "15";
const FETCH_TOTAL_TIMEOUT_S = "30";
const MAX_SEARCH_CALLS_PER_ATTEMPT = 30;
const DEEPSEEK_SEARCH_TIMEOUT_MS = 20000;
const DEEPSEEK_FETCH_TIMEOUT_MS = 30000;
const DEEPSEEK_MAX_ATTEMPTS = 2;
const DEEPSEEK_QUERY_MAX_CHARS = 128;
const DEEPSEEK_REQUEST_PRICE_USD = 0.00075;
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
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
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
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
  // DeepSeek-only metadata; the Bing fallback has no equivalent.
  site?: string;
  publishedAt?: string;
  authority?: number;
  rerankScore?: number;
};


function parseBing(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(blockPattern)) {
    if (results.length >= limit) break;
    const block = match[1];
    const result = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!result) continue;
    const url = htmlDecode(result[1]);
    if (!/^https?:\/\//iu.test(url)) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: stripHtml(result[2]),
      url,
      description: snippet ? stripHtml(snippet[1]) : "",
      position: results.length + 1,
    });
  }
  return results;
}

class SearchBackendError extends Error {}

/** Reuses the DeepSeek Provider credential; there is no separate search key. */
function deepseekCredential(): string | null {
  const key = (process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY__DEEPSEEK ?? "").trim();
  return key.length > 0 ? key : null;
}

function deepseekBaseUrl(): string {
  const configured = (process.env.DEEPSEEK_SEARCH_BASE_URL ?? "").trim() || DEEPSEEK_DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, "").replace(/\/v1$/, "");
}

class DeepSeekRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeepSeekRequestError";
    this.status = status;
  }
}

/** Docs: retry 408/429/5xx only; every other 4xx fails fast. */
function deepseekRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function deepseekErrorHint(status: number): string {
  if (status === 401) return "（DeepSeek API Key 无效，请检查 Provider 凭据）";
  if (status === 402) return "（DeepSeek 账户余额不足）";
  if (status === 429) return "（DeepSeek 限流，请稍后重试）";
  if (status === 403 || status === 404) return "（DeepSeek 拒绝该 URL 或无可用正文）";
  return "";
}

function deepseekDelay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function postDeepSeek(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const apiKey = deepseekCredential();
  if (!apiKey) throw new SearchBackendError("未配置 DeepSeek 凭据");
  const timeoutMs = path === "/v1/tools/fetch" ? DEEPSEEK_FETCH_TIMEOUT_MS : DEEPSEEK_SEARCH_TIMEOUT_MS;
  let lastError: Error = new Error("DeepSeek 请求失败");
  for (let attempt = 0; attempt < DEEPSEEK_MAX_ATTEMPTS; attempt += 1) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { controller.abort(); }, timeoutMs) : null;
    const onAbort = () => { if (controller) controller.abort(); };
    if (controller && signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(deepseekBaseUrl() + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new DeepSeekRequestError(
          response.status,
          "DeepSeek " + path + " 失败（HTTP " + response.status + "）"
            + deepseekErrorHint(response.status)
            + (raw ? "：" + String(raw).slice(0, 200) : ""),
        );
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = lastError instanceof DeepSeekRequestError
        ? deepseekRetryable(lastError.status)
        : true;
      if (!retryable || attempt === DEEPSEEK_MAX_ATTEMPTS - 1) throw lastError;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (controller && signal) signal.removeEventListener("abort", onAbort);
    }
    await deepseekDelay(300 * (attempt + 1));
  }
  throw lastError;
}

async function searchDeepSeek(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (Array.from(query).length > DEEPSEEK_QUERY_MAX_CHARS) {
    throw new SearchBackendError("查询超过 DeepSeek " + DEEPSEEK_QUERY_MAX_CHARS + " 字符上限");
  }
  const data = await postDeepSeek("/v1/tools/search", {
    query,
    count: Math.max(1, Math.min(50, limit)),
  }, signal);
  if (!data || !Array.isArray(data.results)) {
    throw new SearchBackendError("DeepSeek 搜索返回格式无效（缺少 results 数组）");
  }
  const results: SearchResult[] = [];
  for (const entry of data.results) {
    if (results.length >= limit) break;
    if (!entry || typeof entry.url !== "string" || !/^https?:\/\//iu.test(entry.url)) continue;
    const result: SearchResult = {
      title: typeof entry.title === "string" ? stripHtml(entry.title) : "",
      url: entry.url,
      description: stripHtml(
        typeof entry.snippet === "string" && entry.snippet
          ? entry.snippet
          : typeof entry.summary === "string" ? entry.summary : "",
      ),
      position: results.length + 1,
    };
    if (typeof entry.site_name === "string" && entry.site_name) result.site = entry.site_name;
    if (typeof entry.date === "string" && entry.date) result.publishedAt = entry.date;
    if (typeof entry.authority === "number") result.authority = entry.authority;
    if (typeof entry.rerank_score === "number") result.rerankScore = entry.rerank_score;
    results.push(result);
  }
  return results;
}

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

  const startedAt = Date.now();
  const failures: string[] = [];
  const blockedBackends: string[] = [];

  // 1) DeepSeek search API: the preferred backend whenever a DeepSeek
  // credential exists. It is the Provider key, never a separate search key.
  if (deepseekCredential()) {
    try {
      const web = await searchDeepSeek(query, limit, signal);
      if (web.length > 0) {
        const outcome = { web, provider: "deepseek-search-api", elapsedMs: Date.now() - startedAt };
        searchCache.set(cacheKey, outcome);
        return outcome;
      }
      failures.push("deepseek: no results");
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push("deepseek: " + (error as Error).message);
    }
  } else {
    failures.push("deepseek: no credential configured");
  }

  // 2) Bing HTML: keyless fallback with the Chinese market.
  let html = "";
  try {
    html = await runCurl([
      "-L",
      "--silent",
      "--show-error",
      "--get",
      "--data-urlencode",
      "q=" + query,
      "--connect-timeout",
      SEARCH_CONNECT_TIMEOUT_S,
      "--max-time",
      SEARCH_TOTAL_TIMEOUT_S,
      "-A",
      BROWSER_UA,
      "https://www.bing.com/search?count=" + Math.max(limit, 10) + "&mkt=zh-CN",
    ], undefined, signal);
    const blocked = detectBlockedPage(undefined, html);
    if (blocked) {
      blockedBackends.push("bing");
      failures.push("bing: anti-bot verification page");
      html = "";
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    failures.push("bing: " + (error as Error).message);
  }
  const web = html ? parseBing(html, limit) : [];
  if (web.length > 0) {
    const outcome = { web, provider: "bing-html-curl", elapsedMs: Date.now() - startedAt };
    searchCache.set(cacheKey, outcome);
    return outcome;
  }
  if (html && web.length === 0) failures.push("bing: no parseable results");

  throw new SearchBackendError(
    (blockedBackends.length > 0
      ? "搜索被反爬验证页拦截（" + blockedBackends.join("、") + "）：请换关键词或直接访问官方站点；不要用 curl 硬抓，也不要让用户逐个确认链接。"
      : "网络不可用：搜索后端（DeepSeek、Bing）均无法访问。")
    + (failures.length > 0 ? " 原因: " + failures.join("; ") : ""),
  );
}

// Anti-bot/verification pages are not content. Recognizing them keeps a source
// failure on the retry path instead of turning it into a user decision
// (2026-11-11: a Baidu verification page was returned as fetched evidence).
const ANTI_BOT_MARKERS = [
  "百度安全验证", "安全验证", "请输入验证码", "人机验证", "滑动验证", "访问过于频繁",
  "网络不给力，请稍后重试", "身份验证", "环境异常", "拒绝访问",
  "captcha", "verify you are human", "unusual traffic", "access denied",
  "attention required", "just a moment", "checking your browser",
  "enable javascript and cookies to continue", "are you a robot", "request blocked",
];

function detectBlockedPage(title: string | undefined, text: string): string | null {
  const titleText = (title ?? "").toLowerCase();
  const body = text.toLowerCase();
  const marker = ANTI_BOT_MARKERS.find(candidate => {
    const lower = candidate.toLowerCase();
    return titleText.includes(lower) || body.includes(lower);
  });
  if (!marker) return null;
  // A long article that merely discusses captchas is not a block page. Require
  // the marker in the title or a short page that is almost entirely the notice.
  if (titleText.includes(marker.toLowerCase())) return marker;
  return text.length <= 2000 ? marker : null;
}

const BLOCKED_PAGE_GUIDANCE = "该页面是反爬/验证页，不代表真实内容。请更换来源或直接访问官方/一手站点；无法核实时标注为未核实，不要引用本页内容，也不要让用户逐个确认链接。";

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: "首选的 Web 检索通道：配置了 DeepSeek 凭据时走 DeepSeek 搜索 API（返回发布日期、站点权威度与重排分数），否则回落到 Bing HTML 后端；受控超时、结果缓存、中文优化。一切联网检索必须先用它；仅当它返回“网络不可用”时才允许用 bash 里的 curl/wget 兜底。Proxy environment variables such as HTTP_PROXY/HTTPS_PROXY are honored by the Bing fallback.",
  promptSnippet: "web_search(query, limit): search the public web and return titles, URLs and snippets, plus publication dates and authority on the DeepSeek backend.",
  promptGuidelines: [
    "web_search 是所有联网检索的首选（DeepSeek 后端优先，Bing 后端兜底，受控超时、结果缓存）；不要自己用 bash+curl 拼搜索请求，curl 仅作为 web_search 明确不可用时的兜底。",
    "When the result carries publishedAt/authority, use them: prefer recent, authoritative sources and mark stale or unranked claims as such.",
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
        details: {
          provider,
          query: params.query,
          limit,
          elapsedMs,
          resultCount: web.length,
          ...(provider === "deepseek-search-api" ? { estimatedCostUsd: DEEPSEEK_REQUEST_PRICE_USD } : {}),
        },
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

// Research attempts read public pages through DeepSeek's extraction API (it
// refuses local/private targets server-side); workspace attempts keep curl so a
// task can still inspect a local service it just started.
function webFetchBackend(): "deepseek" | "curl" {
  return process.env.METACLAW_PI_WEB_FETCH_BACKEND === "deepseek" ? "deepseek" : "curl";
}

/** Returns either a final result or the reason the curl backend should take over. */
async function fetchDeepSeekPage(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<
  | { kind: "ok"; content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
  | { kind: "fallback"; message: string }
  | { kind: "failed"; message: string; status: number }
> {
  try {
    const data = await postDeepSeek("/v1/tools/fetch", { url: rawUrl }, signal);
    const text = typeof data?.content === "string" ? data.content.trim() : "";
    const title = typeof data?.title === "string" ? data.title.trim() : "";
    if (!text) return { kind: "fallback", message: "DeepSeek Fetch returned no usable content" };
    return {
      kind: "ok",
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          url: rawUrl,
          title: title || undefined,
          text: text.slice(0, 12000),
          provider: "deepseek-fetch-api",
          truncated: text.length > 12000,
        }, null, 2),
      }],
      details: {
        provider: "deepseek-fetch-api",
        url: rawUrl,
        chars: text.length,
        estimatedCostUsd: DEEPSEEK_REQUEST_PRICE_USD,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = (error as Error).message;
    const status = error instanceof DeepSeekRequestError ? error.status : null;
    // Quota, throttling and transport failures are worth a curl retry; a key or
    // page-policy rejection is a terminal answer for this URL.
    if (status === null || status === 402 || status === 429 || status >= 500) {
      return { kind: "fallback", message };
    }
    return { kind: "failed", message, status };
  }
}

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch a public webpage and return readable text. Research attempts use DeepSeek's extraction API; workspace attempts use curl. The curl backend honors proxy environment variables.",
  promptSnippet: "web_fetch(url): fetch a webpage and return title plus readable text excerpt.",
  promptGuidelines: [
    "Use web_fetch to inspect important search results before citing or relying on them.",
    "Prefer official or primary sources when available.",
    "A result with blocked=true is an anti-bot or verification page, not content: switch source or go to the official site, mark the claim unverified if you cannot, and never cite it or ask the user to approve individual links.",
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
    const deepseekFallback: string[] = [];
    if (webFetchBackend() === "deepseek" && deepseekCredential()) {
      const outcome = await fetchDeepSeekPage(rawUrl, signal);
      if (outcome.kind === "ok") return outcome;
      if (outcome.kind === "failed") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              retryable: false,
              provider: "deepseek-fetch-api",
              error: outcome.message,
              url: rawUrl,
              guidance: "DeepSeek 拒绝或无法提取该页面：换来源或直接访问官方站点；无法核实时标注为未核实，不要引用本页内容。",
            }, null, 2),
          }],
          details: { provider: "deepseek-fetch-api", url: rawUrl, httpStatus: outcome.status, failed: true },
        };
      }
      deepseekFallback.push(outcome.message);
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
    const blocked = detectBlockedPage(title ? stripHtml(title) : undefined, text);
    if (blocked) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            blocked: true,
            retryable: true,
            reason: "anti_bot_or_verification_page",
            matched: blocked,
            url: rawUrl,
            guidance: BLOCKED_PAGE_GUIDANCE,
          }, null, 2),
        }],
        details: { provider: "curl", url: rawUrl, blocked: true, matched: blocked },
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: text.length > 0,
          url: rawUrl,
          title: title ? stripHtml(title) : undefined,
          text,
          provider: "curl",
          ...(deepseekFallback.length > 0 ? { backendFallback: deepseekFallback.join("; ") } : {}),
        }, null, 2),
      }],
      details: {
        provider: "curl",
        url: rawUrl,
        ...(deepseekFallback.length > 0 ? { backendFallback: deepseekFallback.join("; ") } : {}),
      },
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
  if (typeof pi.on === "function") {
    pi.on("tool_call", event => { captureToolWrite("before", event.toolName, event.input); });
    pi.on("tool_result", event => { captureToolWrite("after", event.toolName, event.input); });
  }
  if (process.env.METACLAW_PI_WEB_TOOLS_ENABLED !== "0") {
    pi.registerTool(webSearchTool);
    pi.registerTool(webFetchTool);
  }
  pi.registerTool(evidenceListTool);
  pi.registerTool(evidenceSearchTool);
  pi.registerTool(evidenceGetTool);
  pi.registerTool(resultReferenceListTool);
  pi.registerTool(resultReferenceGetTool);
}
`;
