import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PI_WEB_EXTENSION_SOURCE } from '../../src/executor/pi-agent.js';

describe('Pi attempt extension', () => {
  it.each(['0', '1'])('keeps upstream reads available with web tools enabled=%s', async webEnabled => {
    type Tool = { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> };
    const registered = new Map<string, Tool>();
    const exports: { default?: (api: { registerTool(tool: Tool): void }) => void } = {};
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '{"content":"完整草稿"}' });
    const source = ts.transpileModule(PI_WEB_EXTENSION_SOURCE, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInNewContext(source, {
      exports, fetch,
      process: { env: {
        METACLAW_PI_WEB_TOOLS_ENABLED: webEnabled,
        METACLAW_EVIDENCE_JSON_URL: 'http://127.0.0.1:1234/evidence',
        METACLAW_EVIDENCE_TOKEN: 'attempt-token',
      } },
      require: (name: string) => {
        if (name === '@earendil-works/pi-ai') return { Type: new Proxy({}, { get: () => () => ({}) }) };
        if (name === '@earendil-works/pi-coding-agent') return { defineTool: (tool: Tool) => tool };
        if (name === 'node:child_process') return { execFile: vi.fn() };
        throw new Error(`Unexpected extension import: ${name}`);
      },
    });
    exports.default!({ registerTool: tool => { registered.set(tool.name, tool); } });
    expect(registered.has('web_search')).toBe(webEnabled === '1');
    expect(registered.has('web_fetch')).toBe(webEnabled === '1');
    expect(registered.has('evidence_get')).toBe(true);
    expect(registered.has('result_reference_list')).toBe(true);
    await expect(registered.get('result_reference_get')!.execute('read', { referenceId: 'draft' }))
      .resolves.toMatchObject({ content: [{ text: '{"content":"完整草稿"}' }] });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/evidence', expect.objectContaining({
      headers: { authorization: 'Bearer attempt-token', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'result_reference_get', input: { referenceId: 'draft' } }),
    }));
  });

  it('reports an anti-bot verification page as a blocked, retryable source', async () => {
    type Tool = { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> };
    const registered = new Map<string, Tool>();
    const exports: { default?: (api: { registerTool(tool: Tool): void }) => void } = {};
    const verification = '<html><head><title>百度安全验证</title></head><body>百度安全验证 网络不给力，请稍后重试 返回首页 问题反馈</body></html>';
    const execFile = vi.fn((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, verification, '');
      return { stdin: { end: () => undefined } };
    });
    const source = ts.transpileModule(PI_WEB_EXTENSION_SOURCE, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInNewContext(source, {
      exports,
      fetch: vi.fn(),
      URL,
      process: { env: { METACLAW_PI_WEB_TOOLS_ENABLED: '1' } },
      require: (name: string) => {
        if (name === '@earendil-works/pi-ai') return { Type: new Proxy({}, { get: () => () => ({}) }) };
        if (name === '@earendil-works/pi-coding-agent') return { defineTool: (tool: Tool) => tool };
        if (name === 'node:child_process') return { execFile };
        throw new Error(`Unexpected extension import: ${name}`);
      },
    });
    exports.default!({ registerTool: tool => { registered.set(tool.name, tool); } });
    const result = await registered.get('web_fetch')!.execute('call', { url: 'https://www.baidu.com/s?wd=test' }) as {
      content: Array<{ text: string }>; details: Record<string, unknown>;
    };
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: false, blocked: true, retryable: true, reason: 'anti_bot_or_verification_page',
    });
    expect(String(payload.guidance)).toContain('不要让用户逐个确认链接');
    expect(result.details).toMatchObject({ blocked: true });
  });

  it('registers attempt-scoped ResultReference list and get tools', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_get"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_get"');
  });

  it('searches Bing first with the Chinese market and falls back to Baidu before failing closed', () => {
    // Backend chain: Bing (mkt=zh-CN) -> Baidu -> explicit network-unavailable error.
    expect(PI_WEB_EXTENSION_SOURCE).toContain('www.bing.com/search?count=');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('mkt=zh-CN');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('www.baidu.com/s');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('网络不可用');
    // DuckDuckGo is gone.
    expect(PI_WEB_EXTENSION_SOURCE).not.toContain('duckduckgo');
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
    // managed backend chain (Bing -> Baidu) is available.
    expect(PI_WEB_EXTENSION_SOURCE).toContain('首选');
    expect(PI_WEB_EXTENSION_SOURCE).toMatch(/curl[\s\S]{0,120}兜底/);
  });

  it('bounds search time and runaway usage', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_CONNECT_TIMEOUT_S = "5"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_TOTAL_TIMEOUT_S = "15"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('FETCH_TOTAL_TIMEOUT_S = "30"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('MAX_SEARCH_CALLS_PER_ATTEMPT = 30');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('searchCache');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('elapsedMs');
  });
});
