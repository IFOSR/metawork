import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureInternalLlmProvisioned } from '../../src/configuration/internal-llm-provisioning.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('installation-owned internal LLM provisioning', () => {
  it('copies the system DeepSeek Flash configuration before Server startup', async () => {
    const source = await mkdtemp(join(tmpdir(), 'internal-llm-source-'));
    const target = await mkdtemp(join(tmpdir(), 'internal-llm-target-'));
    roots.push(source, target);
    await mkdir(join(source, 'internal'), { recursive: true });
    await writeFile(join(source, 'internal/llm.json'), JSON.stringify({
      provider: 'deepseek', displayName: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-flash', apiKeyRef: 'file-secret:anyfusion/internal/llm', enabled: true,
      timeoutMs: 60000, maxTokens: 4096, thinking: 'disabled',
    }));
    await writeFile(join(source, 'internal/llm-credentials.json'), JSON.stringify({ version: 1, providers: {}, internal: { llm: 'secret' } }));
    await ensureInternalLlmProvisioned({ installRoot: target, sourceRoot: source });
    expect(JSON.parse(await readFile(join(target, 'internal/llm.json'), 'utf8')).modelId).toBe('deepseek-flash');
    expect(JSON.parse(await readFile(join(target, 'internal/llm-credentials.json'), 'utf8')).internal.llm).toBe('secret');
  });

  it('fails closed when a target is incomplete or the source is not the required model', async () => {
    const source = await mkdtemp(join(tmpdir(), 'internal-llm-source-'));
    const target = await mkdtemp(join(tmpdir(), 'internal-llm-target-'));
    roots.push(source, target);
    await mkdir(join(source, 'internal'), { recursive: true });
    await writeFile(join(source, 'internal/llm.json'), JSON.stringify({ modelId: 'other', enabled: true }));
    await expect(ensureInternalLlmProvisioned({ installRoot: target, sourceRoot: source })).rejects.toThrow('DeepSeek Flash');
    await mkdir(join(target, 'internal'), { recursive: true });
    await writeFile(join(target, 'internal/llm.json'), '{}');
    await expect(ensureInternalLlmProvisioned({ installRoot: target, sourceRoot: source })).rejects.toThrow('incomplete');
  });
});
