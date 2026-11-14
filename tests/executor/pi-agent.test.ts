import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PI_WEB_EXTENSION_SOURCE } from '../../src/executor/pi-agent.js';

type CurlOutcome = { stdout: string; error?: Error };
type Tool = { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> };
type ToolResult = { content: Array<{ text: string }>; details?: Record<string, unknown> };

const execFile = vi.fn(
  (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    callback(null, '', '');
    return { stdin: { end: () => undefined } };
  },
);

function curlReturns(outcome: CurlOutcome): void {
  execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(outcome.error ?? null, outcome.stdout, outcome.error ? outcome.error.message : '');
    return { stdin: { end: () => undefined } };
  });
}

beforeEach(() => {
  execFile.mockReset();
  curlReturns({ stdout: '' });
});

function loadExtension(input: {
  fetch: unknown;
  env: Record<string, string>;
}): { registered: Map<string, Tool>; mount(): void } {
  const registered = new Map<string, Tool>();
  const exports: { default?: (api: { registerTool(tool: Tool): void }) => void } = {};
  const source = ts.transpileModule(PI_WEB_EXTENSION_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(source, {
    exports,
    fetch: input.fetch,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { env: input.env },
    require: (name: string) => {
      if (name === '@earendil-works/pi-ai') return { Type: new Proxy({}, { get: () => () => ({}) }) };
      if (name === '@earendil-works/pi-coding-agent') return { defineTool: (tool: Tool) => tool };
      if (name === 'node:child_process') return { execFile };
      throw new Error(`Unexpected extension import: ${name}`);
    },
  });
  return {
    registered,
    mount: () => { exports.default!({ registerTool: tool => { registered.set(tool.name, tool); } }); },
  };
}

function payloadOf(result: unknown): Record<string, unknown> {
  return JSON.parse((result as ToolResult).content[0]!.text) as Record<string, unknown>;
}

describe('Pi attempt extension', () => {
  it.each(['0', '1'])('keeps upstream reads available with web tools enabled=%s', async webEnabled => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '{"content":"完整草稿"}' });
    const extension = loadExtension({
      fetch,
      env: {
        METACLAW_PI_WEB_TOOLS_ENABLED: webEnabled,
        METACLAW_EVIDENCE_JSON_URL: 'http://127.0.0.1:1234/evidence',
        METACLAW_EVIDENCE_TOKEN: 'attempt-token',
      },
    });
    extension.mount();
    expect(extension.registered.has('web_search')).toBe(webEnabled === '1');
    expect(extension.registered.has('web_fetch')).toBe(webEnabled === '1');
    expect(extension.registered.has('evidence_get')).toBe(true);
    expect(extension.registered.has('result_reference_list')).toBe(true);
    await expect(extension.registered.get('result_reference_get')!.execute('read', { referenceId: 'draft' }))
      .resolves.toMatchObject({ content: [{ text: '{"content":"完整草稿"}' }] });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/evidence', expect.objectContaining({
      headers: { authorization: 'Bearer attempt-token', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'result_reference_get', input: { referenceId: 'draft' } }),
    }));
  });

  it('reports an anti-bot verification page as a blocked, retryable source', async () => {
    curlReturns({
      stdout: '<html><head><title>百度安全验证</title></head><body>百度安全验证 网络不给力，请稍后重试 返回首页 问题反馈</body></html>',
    });
    const extension = loadExtension({ fetch: vi.fn(), env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1' } });
    extension.mount();
    const result = await extension.registered.get('web_fetch')!.execute('call', { url: 'https://example.com/x' });
    expect(payloadOf(result)).toMatchObject({
      success: false, blocked: true, retryable: true, reason: 'anti_bot_or_verification_page',
    });
    expect(String(payloadOf(result).guidance)).toContain('不要让用户逐个确认链接');
    expect((result as ToolResult).details).toMatchObject({ blocked: true });
  });

  it('registers attempt-scoped ResultReference list and get tools', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_get"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_get"');
  });

  it('searches DeepSeek first and falls back to Bing before failing closed', () => {
    // Backend chain: DeepSeek search API -> Bing (mkt=zh-CN) -> explicit network-unavailable error.
    expect(PI_WEB_EXTENSION_SOURCE).toContain('DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('"/v1/tools/search"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('deepseekCredential()');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('www.bing.com/search?count=');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('mkt=zh-CN');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('网络不可用');
    // Baidu and DuckDuckGo are gone.
    expect(PI_WEB_EXTENSION_SOURCE).not.toContain('www.baidu.com');
    expect(PI_WEB_EXTENSION_SOURCE).not.toContain('duckduckgo');
  });

  it('returns DeepSeek results with publication metadata as the primary backend', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: '2026 期货主力合约复盘',
            url: 'https://example.com/futures',
            snippet: '螺纹钢主力增仓',
            site_name: 'example.com',
            date: '2026-11-13',
            authority: 3,
            rerank_score: 0.91,
          },
          { title: 'unusable', url: 'javascript:void(0)' },
        ],
      }),
    });
    const extension = loadExtension({
      fetch,
      env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1', DEEPSEEK_API_KEY: 'sk-deepseek' },
    });
    extension.mount();
    const result = await extension.registered.get('web_search')!.execute('call', {
      query: '螺纹钢 主力', limit: 5,
    });
    const payload = payloadOf(result) as {
      success: boolean; provider: string; data: { web: Array<Record<string, unknown>> };
    };
    expect(payload.success).toBe(true);
    expect(payload.provider).toBe('deepseek-search-api');
    expect(payload.data.web).toEqual([{
      title: '2026 期货主力合约复盘',
      url: 'https://example.com/futures',
      description: '螺纹钢主力增仓',
      position: 1,
      site: 'example.com',
      publishedAt: '2026-11-13',
      authority: 3,
      rerankScore: 0.91,
    }]);
    expect(fetch).toHaveBeenCalledWith('https://api.deepseek.com/v1/tools/search', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer sk-deepseek' }),
      body: JSON.stringify({ query: '螺纹钢 主力', count: 5 }),
    }));
    // Bing must not be touched once DeepSeek answers.
    expect(execFile).not.toHaveBeenCalled();
  });

  it('falls back to Bing when the DeepSeek backend fails', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'upstream down' });
    curlReturns({
      stdout: '<html><body><ol><li class="b_algo"><h2><a href="https://example.com/bing">Bing 结果</a></h2><p>摘要</p></li></ol></body></html>',
    });
    const extension = loadExtension({
      fetch,
      env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1', DEEPSEEK_API_KEY: 'sk-deepseek' },
    });
    extension.mount();
    const payload = payloadOf(await extension.registered.get('web_search')!.execute('call', {
      query: 'metawork', limit: 3,
    })) as { success: boolean; provider: string; data: { web: Array<Record<string, unknown>> } };
    expect(payload.provider).toBe('bing-html-curl');
    expect(payload.data.web).toHaveLength(1);
    // 500 is retryable: two DeepSeek attempts before the Bing fallback.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports an empty backend chain as network-unavailable with both reasons', async () => {
    curlReturns({ stdout: '', error: new Error('curl: (6) Could not resolve host') });
    const extension = loadExtension({ fetch: vi.fn(), env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1' } });
    extension.mount();
    const payload = payloadOf(await extension.registered.get('web_search')!.execute('call', {
      query: 'metawork', limit: 3,
    })) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('网络不可用');
    expect(payload.error).toContain('deepseek: no credential configured');
    expect(payload.error).toContain('bing:');
  });

  it('reads research pages through DeepSeek when the affordance selects that backend', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: '示例页', content: '  正文 Markdown  ' }),
    });
    const extension = loadExtension({
      fetch,
      env: {
        METACLAW_PI_WEB_TOOLS_ENABLED: '1',
        METACLAW_PI_WEB_FETCH_BACKEND: 'deepseek',
        DEEPSEEK_API_KEY: 'sk-deepseek',
      },
    });
    extension.mount();
    const result = await extension.registered.get('web_fetch')!.execute('call', { url: 'https://example.com/article' });
    expect(payloadOf(result)).toMatchObject({
      success: true, provider: 'deepseek-fetch-api', title: '示例页', text: '正文 Markdown',
    });
    expect((result as ToolResult).details).toMatchObject({ provider: 'deepseek-fetch-api' });
    expect(fetch).toHaveBeenCalledWith('https://api.deepseek.com/v1/tools/fetch', expect.objectContaining({
      body: JSON.stringify({ url: 'https://example.com/article' }),
    }));
    expect(execFile).not.toHaveBeenCalled();
  });

  it('surfaces a DeepSeek page-policy rejection without falling back to curl', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'rejected' });
    const extension = loadExtension({
      fetch,
      env: {
        METACLAW_PI_WEB_TOOLS_ENABLED: '1',
        METACLAW_PI_WEB_FETCH_BACKEND: 'deepseek',
        DEEPSEEK_API_KEY: 'sk-deepseek',
      },
    });
    extension.mount();
    const result = await extension.registered.get('web_fetch')!.execute('call', { url: 'https://example.com/private' });
    expect(payloadOf(result)).toMatchObject({
      success: false, retryable: false, provider: 'deepseek-fetch-api',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps local targets reachable with the default curl fetch backend', async () => {
    curlReturns({ stdout: '<html><head><title>Local</title></head><body>ok</body></html>' });
    const fetch = vi.fn();
    const extension = loadExtension({
      fetch,
      env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1', DEEPSEEK_API_KEY: 'sk-deepseek' },
    });
    extension.mount();
    const result = await extension.registered.get('web_fetch')!.execute('call', { url: 'http://127.0.0.1:7999/health' });
    expect(payloadOf(result)).toMatchObject({ success: true, provider: 'curl' });
    expect((result as ToolResult).details).toMatchObject({ provider: 'curl' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('parses as valid TypeScript when emitted into an attempt home', () => {
    // Regression: the extension source is a String.raw template — every
    // backslash lands verbatim in the emitted file, so regex literals must use
    // single escapes. A double-escaped `\\/` once broke parsing with
    // "Invalid regular expression flag" and killed every pi attempt at startup.
    const result = ts.transpileModule(PI_WEB_EXTENSION_SOURCE, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const errors = (result.diagnostics ?? [])
      .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    expect(errors).toEqual([]);
  });

  it('declares web_search as the primary web channel and curl as fallback only', () => {
    // Steering contract: the model must not hand-roll curl searches while the
    // managed backend chain (DeepSeek -> Bing) is available.
    expect(PI_WEB_EXTENSION_SOURCE).toContain('首选');
    expect(PI_WEB_EXTENSION_SOURCE).toMatch(/curl[\s\S]{0,120}兜底/);
  });

  it('bounds search time and runaway usage', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_CONNECT_TIMEOUT_S = "5"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_TOTAL_TIMEOUT_S = "15"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('FETCH_TOTAL_TIMEOUT_S = "30"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('DEEPSEEK_SEARCH_TIMEOUT_MS = 20000');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('DEEPSEEK_FETCH_TIMEOUT_MS = 30000');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('MAX_SEARCH_CALLS_PER_ATTEMPT = 30');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('searchCache');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('elapsedMs');
  });
});
