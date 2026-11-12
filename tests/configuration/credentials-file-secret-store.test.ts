import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CredentialsFileSecretStore', () => {
  it('stores Provider credentials in the simple MetaWork JSON format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const store = new CredentialsFileSecretStore(filePath);

    await store.put('file-secret:anyfusion/providers/openai', 'sk-first');
    await store.put('keychain:anyfusion/providers/deepseek', 'sk-second');

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      providers: {
        openai: 'sk-first',
        deepseek: 'sk-second',
      },
    });
    await expect(store.get('keychain:anyfusion/providers/openai')).resolves.toBe('sk-first');
  });

  it('replaces one Provider without losing other credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const store = new CredentialsFileSecretStore(join(root, 'credentials.json'));

    await store.put('file-secret:anyfusion/providers/openai', 'sk-old');
    await store.put('file-secret:anyfusion/providers/deepseek', 'sk-deepseek');
    await store.put('file-secret:anyfusion/providers/openai', 'sk-new');

    await expect(store.get('file-secret:anyfusion/providers/openai')).resolves.toBe('sk-new');
    await expect(store.get('file-secret:anyfusion/providers/deepseek')).resolves.toBe('sk-deepseek');
  });

  it('rejects malformed credentials without overwriting the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    await writeFile(filePath, '{broken', 'utf8');
    const store = new CredentialsFileSecretStore(filePath);

    await expect(store.put('file-secret:anyfusion/providers/openai', 'sk-new'))
      .rejects.toThrow(/credentials\.json/i);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{broken');
  });

  it('creates a private credentials file and deletes only one Provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const store = new CredentialsFileSecretStore(filePath);

    await store.put('file-secret:anyfusion/providers/openai', 'sk-openai');
    await store.put('file-secret:anyfusion/providers/deepseek', 'sk-deepseek');
    await store.delete('file-secret:anyfusion/providers/openai');

    await expect(store.get('file-secret:anyfusion/providers/openai')).rejects.toThrow(/missing/i);
    await expect(store.get('file-secret:anyfusion/providers/deepseek')).resolves.toBe('sk-deepseek');
    // The mode-0600 contract belongs to POSIX files. Windows has no POSIX
    // permission bits, so the file inherits the directory's ACL instead.
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects non-Provider secret references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const store = new CredentialsFileSecretStore(join(root, 'credentials.json'));

    await expect(store.put('file-secret:anyfusion/other/service', 'value'))
      .rejects.toThrow(/provider/i);
  });

  it('keeps internal secrets isolated from a Provider with the same name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const store = new CredentialsFileSecretStore(filePath);
    const providerReference = 'file-secret:anyfusion/providers/routing-span';
    const internalReference = 'file-secret:anyfusion/internal/routing-span';

    await store.put(providerReference, 'provider-key-value');
    await store.put(internalReference, 'internal-key-value');

    // Neither write may shadow the other: this is the collision that made the
    // previous flat namespace unsafe for a Provider literally named
    // `routing-span`.
    await expect(store.get(providerReference)).resolves.toBe('provider-key-value');
    await expect(store.get(internalReference)).resolves.toBe('internal-key-value');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      providers: { 'routing-span': 'provider-key-value' },
      internal: { 'routing-span': 'internal-key-value' },
    });

    await store.delete(internalReference);
    await expect(store.get(internalReference)).rejects.toThrow(/missing/i);
    await expect(store.get(providerReference)).resolves.toBe('provider-key-value');
  });

  it('round-trips internal secrets without dropping Provider credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const store = new CredentialsFileSecretStore(join(root, 'credentials.json'));

    await store.put('file-secret:anyfusion/internal/routing-span', 'sk-span');
    await store.put('file-secret:anyfusion/providers/openai', 'sk-openai');
    await store.put('file-secret:anyfusion/internal/routing-span', 'sk-span-rotated');
    await store.putProviders({ deepseek: 'sk-deepseek' });

    await expect(store.get('file-secret:anyfusion/internal/routing-span'))
      .resolves.toBe('sk-span-rotated');
    await expect(store.get('file-secret:anyfusion/providers/openai')).resolves.toBe('sk-openai');
    await expect(store.get('file-secret:anyfusion/providers/deepseek')).resolves.toBe('sk-deepseek');
  });

  it('never lets a staged credential overwrite the active Provider credential', async () => {
    // 用户编辑已激活的 Provider 并填了无效密钥、尚未保存激活：待激活暂存
    // 必须落在独立命名空间，绝不能覆盖正在生效的那份密钥——否则原本可用的
    // 模型会立刻失效，所有使用它的任务一起坏掉。
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const store = new CredentialsFileSecretStore(join(root, 'credentials.json'));
    const activeReference = 'file-secret:anyfusion/providers/kimi';
    const pendingReference = 'file-secret:anyfusion/pending/kimi';

    await store.put(activeReference, 'sk-working-key');
    await store.put(pendingReference, 'sk-unvalidated-key');

    await expect(store.get(activeReference)).resolves.toBe('sk-working-key');
    await expect(store.get(pendingReference)).resolves.toBe('sk-unvalidated-key');

    // 转正：删除 pending 槽位不影响已激活的那份。
    await store.delete(pendingReference);
    await expect(store.get(pendingReference)).rejects.toThrow(/missing/i);
    await expect(store.get(activeReference)).resolves.toBe('sk-working-key');
  });

  it('keeps a staged credential for a Provider that is not active yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credentials-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const store = new CredentialsFileSecretStore(filePath);

    await store.put('file-secret:anyfusion/pending/custom-model-1', 'sk-new-provider');

    await expect(store.get('file-secret:anyfusion/pending/custom-model-1'))
      .resolves.toBe('sk-new-provider');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      providers: {},
      pending: { 'custom-model-1': 'sk-new-provider' },
    });
  });
});
