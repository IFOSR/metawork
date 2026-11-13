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

function parseBaidu(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<div[^>]+class=["'][^"']*result[^"']*c-container[^"']*["'][^>]*>([\s\S]*?)<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(blockPattern)) {
    if (results.length >= limit) break;
    const url = htmlDecode(match[2]);
    if (!/^https?:\/\//iu.test(url)) continue;
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
  const blockedBackends: string[] = [];
  try {
    html = await request(` + "`https://www.bing.com/search?count=${Math.max(limit, 10)}&mkt=zh-CN`" + `, "q");
    const blocked = detectBlockedPage(undefined, html);
    if (blocked) {
      blockedBackends.push("bing");
      failures.push("bing: anti-bot verification page");
      html = "";
    }
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
    const blocked = detectBlockedPage(undefined, html);
    if (blocked) {
      blockedBackends.push("baidu");
      failures.push("baidu: anti-bot verification page");
      html = "";
    }
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
    (blockedBackends.length > 0
      ? "搜索被反爬验证页拦截（" + blockedBackends.join("、") + "）：请换关键词或直接访问官方站点；不要用 curl 硬抓，也不要让用户逐个确认链接。"
      : "网络不可用：搜索后端（Bing、百度）均无法访问。")
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
  description: "首选的 Web 检索通道：托管后端（Bing→百度链）、受控超时、结果缓存、中文优化。一切联网检索必须先用它；仅当它返回“网络不可用”时才允许用 bash 里的 curl/wget 兜底。Proxy environment variables such as HTTP_PROXY/HTTPS_PROXY are honored.",
  promptSnippet: "web_search(query, limit): search the public web and return titles, URLs, and snippets. 联网检索的首选工具。",
  promptGuidelines: [
    "web_search 是所有联网检索的首选（managed backends、受控超时、结果缓存）；不要自己用 bash+curl 拼搜索请求，curl 仅作为 web_search 明确不可用时的兜底。",
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
