// Adapts the Pi coding agent with a generated web-search extension for source-backed research tasks.
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildEnvFromFile } from '../utils/env-file.js';
import { CommandLineExecutorAdapter } from './command-line-adapter.js';
import type { ExecutorInput } from './adapter.js';

const PI_WEB_EXTENSION_PATH = join(homedir(), '.metaclaw', 'pi-extensions', 'metaclaw-web-tools.ts');

const PI_RESEARCH_SYSTEM_PROMPT = [
  'Metaclaw routes research and source-backed tasks to you with web tools enabled.',
  'Use web_search automatically whenever the task needs current information, source attribution, online verification, market/company/product research, or time-sensitive facts.',
  'Use web_fetch to inspect important URLs from search results before making source-backed claims.',
  'If a web tool fails, retry with a narrower query or another result before falling back to prior knowledge.',
  'When online verification is required but all web access fails, explicitly state the network limitation and do not present stale knowledge as verified fact.',
].join('\n');

const PI_WEB_EXTENSION_SOURCE = String.raw`
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

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
  return htmlDecode(value.replace(new RegExp("<script[\\\\s\\\\S]*?<\\\\/script>", "gi"), " ")
    .replace(new RegExp("<style[\\\\s\\\\S]*?<\\\\/style>", "gi"), " ")
    .replace(new RegExp("<[^>]*>", "g"), " ")
    .replace(new RegExp("\\\\s+", "g"), " ")
    .trim());
}

function normalizeDuckDuckGoUrl(rawUrl: string): string {
  const decoded = htmlDecode(rawUrl);
  if (decoded.startsWith("//duckduckgo.com/l/?")) {
    const url = new URL(` + "`https:${decoded}`" + `);
    return url.searchParams.get("uddg") ?? decoded;
  }
  if (decoded.startsWith("/l/?")) {
    const url = new URL(` + "`https://duckduckgo.com${decoded}`" + `);
    return url.searchParams.get("uddg") ?? decoded;
  }
  return decoded;
}

type SearchResult = {
  title: string;
  url: string;
  description: string;
  position: number;
};

function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const htmlPattern = new RegExp("<a[^>]+class=[\\"'][^\\"']*result__a[^\\"']*[\\"'][^>]+href=[\\"']([^\\"']+)[\\"'][^>]*>([\\\\s\\\\S]*?)<\\\\/a>[\\\\s\\\\S]*?<a[^>]+class=[\\"'][^\\"']*result__snippet[^\\"']*[\\"'][^>]*>([\\\\s\\\\S]*?)<\\\\/a>", "g");
  for (const match of html.matchAll(htmlPattern)) {
    if (results.length >= limit) break;
    const url = normalizeDuckDuckGoUrl(match[1]);
    if (!url || url.includes("duckduckgo.com/y.js")) continue;
    results.push({
      title: stripHtml(match[2]),
      url,
      description: stripHtml(match[3]),
      position: results.length + 1,
    });
  }

  if (results.length > 0) return results;

  const litePattern = new RegExp("<a rel=\\"nofollow\\" href=\\"([^\\"]+)\\"[^>]*>([\\\\s\\\\S]*?)<\\\\/a>[\\\\s\\\\S]*?<td[^>]*class=['\\"]result-snippet['\\"][^>]*>([\\\\s\\\\S]*?)<\\\\/td>", "g");
  for (const match of html.matchAll(litePattern)) {
    if (results.length >= limit) break;
    const url = normalizeDuckDuckGoUrl(match[1]);
    if (!url || url.includes("duckduckgo.com/y.js")) continue;
    results.push({
      title: stripHtml(match[2]),
      url,
      description: stripHtml(match[3]),
      position: results.length + 1,
    });
  }
  return results;
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
    const html = await runCurl([
      "-L",
      "--silent",
      "--show-error",
      "--get",
      "--data-urlencode",
      ` + "`q=${String(params.query)}`" + `,
      "--max-time",
      "60",
      "-A",
      "Mozilla/5.0 (compatible; metaclaw-pi-web-search/1.0)",
      "https://html.duckduckgo.com/html/",
    ], undefined, signal);
    const web = parseDuckDuckGo(html, limit);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: web.length > 0,
          data: { web },
          error: web.length > 0 ? undefined : "No parseable search results returned.",
          provider: "duckduckgo-html-curl",
        }, null, 2),
      }],
      details: { provider: "duckduckgo-html-curl", query: params.query, limit },
    };
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
      "--max-time",
      "60",
      "-A",
      "Mozilla/5.0 (compatible; metaclaw-pi-web-fetch/1.0)",
      rawUrl,
    ], undefined, signal);
    const title = html.match(new RegExp("<title[^>]*>([\\\\s\\\\S]*?)<\\\\/title>", "i"))?.[1];
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

export default function (pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  pi.registerTool(evidenceListTool);
  pi.registerTool(evidenceSearchTool);
  pi.registerTool(evidenceGetTool);
}
`;

function ensurePiWebExtension(): string {
  const dir = join(homedir(), '.metaclaw', 'pi-extensions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(PI_WEB_EXTENSION_PATH, PI_WEB_EXTENSION_SOURCE);
  return PI_WEB_EXTENSION_PATH;
}

/** Runs Pi with MetaClaw's generated web tools extension and research-oriented system prompt. */
export class PiAgentAdapter extends CommandLineExecutorAdapter {
  readonly name = 'pi-agent';

  protected buildSpawnArgs(prompt: string): string[] {
    return [
      '--no-extensions',
      '--extension',
      ensurePiWebExtension(),
      '--tools',
      'web_search,web_fetch,evidence_list,evidence_search,evidence_get,bash,read,write,edit,grep,find,ls',
      '--append-system-prompt',
      PI_RESEARCH_SYSTEM_PROMPT,
      '-p',
      prompt,
    ];
  }

  protected buildSpawnEnv(input?: ExecutorInput): NodeJS.ProcessEnv {
    const binding = input?.context.evidenceTools.binding;
    return {
      ...buildEnvFromFile(process.env.METACLAW_PI_EXECUTOR_ENV_FILE),
      ...(binding ? {
        METACLAW_EVIDENCE_JSON_URL: binding.jsonUrl,
        METACLAW_EVIDENCE_TOKEN: binding.bearerToken,
      } : {}),
    };
  }
}
