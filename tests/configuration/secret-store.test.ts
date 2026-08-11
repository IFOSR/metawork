import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { KeychainSecretStore } from '../../src/configuration/keychain-secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('FileSecretStore', () => {
  it('stores only explicit file-secret references with secure permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-file-secrets-'));
    roots.push(root);
    const store = new FileSecretStore(root);
    await store.put('file-secret:openai', 'sk-test-secret');

    expect(await store.get('file-secret:openai')).toBe('sk-test-secret');
    expect(await readdir(root)).toHaveLength(1);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, (await readdir(root))[0]))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(root, (await readdir(root))[0]), 'utf8'))).toBe('sk-test-secret');
    await expect(store.put('keychain:openai', 'secret')).rejects.toThrow(/file-secret/i);
  });
});

describe('KeychainSecretStore', () => {
  it('passes secret values through stdin and never argv or diagnostics', async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const run = vi.fn(async (args: readonly string[], stdin?: string) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: stdin ? '' : 'sk-test-secret\n', stderr: '' };
    });
    const store = new KeychainSecretStore(run);

    await store.put('keychain:openai', 'sk-test-secret');
    expect(await store.get('keychain:openai')).toBe('sk-test-secret');
    expect(calls[0].args).not.toContain('sk-test-secret');
    expect(calls[0].stdin).toBe('sk-test-secret');
    expect(JSON.stringify(calls.map(call => call.args))).not.toContain('sk-test-secret');
  });

  it('does not silently fall back when Keychain access fails', async () => {
    const store = new KeychainSecretStore(async () => ({
      code: 36,
      stdout: '',
      stderr: 'keychain unavailable',
    }));
    await expect(store.get('keychain:openai')).rejects.toThrow(/status 36/i);
  });
});
