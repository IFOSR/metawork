import { describe, expect, it } from 'vitest';
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

  it('bounds search time and runaway usage', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_CONNECT_TIMEOUT_S = "5"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('SEARCH_TOTAL_TIMEOUT_S = "15"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('FETCH_TOTAL_TIMEOUT_S = "30"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('MAX_SEARCH_CALLS_PER_ATTEMPT = 30');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('searchCache');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('elapsedMs');
  });
});
