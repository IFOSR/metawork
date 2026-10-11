import { describe, expect, it } from 'vitest';
import {
  extractHtmlInformation,
  fetchManualModelInformation,
} from '../../src/configuration/manual-model-information.js';

describe('manual model information', () => {
  it('extracts a title, meta description and readable body text from HTML', () => {
    const result = extractHtmlInformation(`
      <html><head><title>Demo &amp; Model</title>
        <meta name="description" content="Fast &amp; capable model">
        <style>.hidden { display:none }</style>
      </head><body><h1>Demo</h1><p>Supports tools and long context.</p>
        <script>alert('ignored')</script></body></html>
    `);
    expect(result.title).toBe('Demo & Model');
    expect(result.description).toContain('Fast & capable model');
    expect(result.description).toContain('Supports tools and long context.');
    expect(result.description).not.toContain('alert');
  });

  it('rejects local and non-HTTPS sources before making a request', async () => {
    await expect(fetchManualModelInformation('http://example.com/model')).rejects.toThrow('只支持 HTTPS');
    await expect(fetchManualModelInformation('https://localhost/model')).rejects.toThrow('本地链接');
    await expect(fetchManualModelInformation('https://127.0.0.1/model')).rejects.toThrow('内网链接');
  });
});
