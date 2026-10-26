import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KERNEL_AUTH_TOKEN_ENV_VAR, renderMemorySidecarConfig } from '../../src/memory/memory-sidecar-config.js';

describe('memory sidecar configuration', () => {
  it('matches the deposition contract of the engine pipeline', () => {
    const config = renderMemorySidecarConfig({
      port: 8420,
      dataDir: '/tmp/memory',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnvVar: 'TDAI_LLM_API_KEY',
      serviceId: 'metawork',
    });
    // MetaWork deposits whole segments, so the engine must not wait for a
    // conversation count and must not warm up exponentially (design §5.4).
    expect(config).toContain('everyNConversations: 1');
    expect(config).toContain('enableWarmup: false');
    expect(config).toContain('l1IdleTimeoutSeconds: 30');
    // BM25 with Chinese tokenization is the only retrieval path.
    expect(config).toContain('bm25:');
    expect(config).toContain('language: "zh"');
    expect(config).toContain('provider: "none"');
  });

  it('never embeds a credential in the generated file', () => {
    const config = renderMemorySidecarConfig({
      port: 8420,
      dataDir: '/tmp/memory',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnvVar: 'TDAI_LLM_API_KEY',
      serviceId: 'metawork',
    });
    expect(config).not.toMatch(/sk-[A-Za-z0-9]{8,}/u);
    // Both credentials are environment expansions, not literals.
    expect(config).toContain(`\${${KERNEL_AUTH_TOKEN_ENV_VAR}}`);
    expect(config).toContain('${TDAI_LLM_API_KEY}');
  });

  it('keeps the engine bound to loopback', () => {
    const config = renderMemorySidecarConfig({
      port: 9_000,
      dataDir: '/tmp/memory',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKeyEnvVar: 'TDAI_LLM_API_KEY',
      serviceId: 'metawork',
    });
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain('port: 9000');
    expect(config).toContain('deployMode: standalone');
    expect(config).toContain('stateBackend: "local"');
  });

  it('quotes paths that contain spaces', () => {
    const config = renderMemorySidecarConfig({
      port: 8_420,
      dataDir: '/tmp/with space/memory',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKeyEnvVar: 'TDAI_LLM_API_KEY',
      serviceId: 'metawork',
    });
    expect(config).toContain('baseDir: "/tmp/with space/memory"');
  });
});
