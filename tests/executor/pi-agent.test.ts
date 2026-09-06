import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { PI_WEB_EXTENSION_SOURCE } from '../../src/executor/pi-agent.js';

describe('Pi attempt extension', () => {
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
