import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionSecretStore } from '../../src/configuration/production-secret-store.js';
import { loadWindowsPrivateFiles, type WindowsPrivateFileRoot } from '../../src/platform/windows-private-files.js';
import { readEndpointManifest, writeEndpointManifest, type EndpointManifest } from '../../src/server/server-endpoint-manifest.js';

describe.skipIf(process.platform !== 'win32')('native Windows credential and endpoint stores', () => {
  let temporary: string;
  let windows: WindowsPrivateFileRoot;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'mw-stores-'));
    windows = { root: join(temporary, '私有 installation'),
      files: loadWindowsPrivateFiles(resolve('native/windows/build/Release/metawork_platform.node')) };
    windows.files.ensurePrivateDirectory(windows.root);
  });
  afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

  it('preserves Provider/internal namespace and delete semantics through native atomic writes', async () => {
    const path = join(windows.root, 'credentials.json');
    const store = createProductionSecretStore({ credentialsFile: path, windows });
    await store.validate(); // Only a missing final file initializes an empty store.
    await store.put('file-secret:anyfusion/providers/provider', 'provider-fixture');
    await store.put('file-secret:anyfusion/internal/span', 'internal-fixture');
    expect(await store.get('file-secret:anyfusion/providers/provider')).toBe('provider-fixture');
    expect(await store.get('file-secret:anyfusion/internal/span')).toBe('internal-fixture');
    await store.delete('file-secret:anyfusion/providers/provider');
    await expect(store.get('file-secret:anyfusion/providers/provider')).rejects.toThrow(/missing/u);
    expect(await store.get('file-secret:anyfusion/internal/span')).toBe('internal-fixture');
    expect(JSON.parse(windows.files.readPrivateFile(windows.root, 'credentials.json').toString()))
      .toEqual({ version: 1, providers: {}, internal: { span: 'internal-fixture' } });
  });
  it('refuses junction redirection without overwriting the destination secret', async () => {
    const outside = join(temporary, 'outside.json');
    await writeFile(outside, 'preserve');
    const redirected = join(windows.root, 'redirected');
    await symlink(temporary, redirected, 'junction');
    const store = createProductionSecretStore({ credentialsFile: join(redirected, 'outside.json'), windows });
    await expect(store.put('file-secret:anyfusion/providers/provider', 'new')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('preserve');
  });
  it('publishes an endpoint readable by both the guarded Desktop path and existing clients', async () => {
    const path = join(windows.root, 'server-endpoint.json');
    const manifest: EndpointManifest = { manifestVersion: 1, serverVersion: 'fixture', releaseId: 'fixture',
      pid: process.pid, startedAt: new Date().toISOString(), state: 'ready', gatewayProtocolVersion: 2,
      unixSocketPath: '\\\\.\\pipe\\metawork-store-test', webOrigin: 'http://127.0.0.1:8788' };
    await writeEndpointManifest(path, manifest, windows);
    expect(await readEndpointManifest(path)).toEqual(manifest);
    expect(JSON.parse(windows.files.readPrivateFile(windows.root, 'server-endpoint.json').toString())).toEqual(manifest);
    await writeEndpointManifest(path, { ...manifest, state: 'draining' }, windows);
    expect((await readEndpointManifest(path))?.state).toBe('draining');
  });
  it('distinguishes a missing final file from invalid or missing ancestors', () => {
    expect(() => windows.files.readPrivateFile(windows.root, 'absent.json')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    let failure: unknown;
    try { windows.files.readPrivateFile(windows.root, 'absent\\secret.json'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).not.toBe('ENOENT');
  });
});
