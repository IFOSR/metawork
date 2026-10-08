import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionSecretStore } from '../../src/configuration/production-secret-store.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import { dump } from 'js-yaml';
import Database from 'better-sqlite3';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileConversationPresentationStore } from '../../src/storage/file-conversation-presentation-store.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ReleasePointerTransaction, type ReleasePointerName } from '../../src/installation/release-pointer-transaction.js';
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
    // Multiple valid provider keys may exceed the native primitive's default
    // 64 KiB. Credential documents request the explicit larger bounded limit.
    const values = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`provider-${index}`, 'x'.repeat(8192)]));
    await store.putProviders(values);
    expect(await store.get('file-secret:anyfusion/providers/provider-11')).toBe(values['provider-11']);
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
  it('persists revisions and recovers a prepared activation through native durable files', async () => {
    const repository = new FileConfigurationRepository(join(windows.root, 'configuration'), windows);
    await repository.initialize();
    const config = AnyFusionConfigurationV2Schema.parse({ schemaVersion: 2, providers: {}, models: {}, harnesses: {},
      agentClasses: {}, permissionProfiles: {}, runtimePolicy: {}, gateway: {} });
    for (const revisionId of ['first', 'second']) {
      await repository.writeRevision({ revisionId, contentHash: revisionId, files: { 'config.yaml': dump(config) } });
    }
    await repository.activateRevision('first', null);
    expect((await repository.getActiveSnapshot()).revisionId).toBe('first');
    await repository.journal.writePrepared({ transactionId: 'interrupted', previousRevisionId: 'first', nextRevisionId: 'second' });
    await repository.replaceActivePointer('second');
    const recovered = new FileConfigurationRepository(repository.rootPath, windows);
    expect(await recovered.recover()).toEqual({ status: 'recovered', activeRevisionId: 'second' });
    expect((await recovered.journal.read())?.phase).toBe('committed');
    expect((await recovered.getActiveSnapshot()).revisionId).toBe('second');
    await recovered.restoreActiveRevision('first', 'second');
    expect((await recovered.getActiveSnapshot()).revisionId).toBe('first');
  });
  it('preserves Conversation JSON and segmented journal facts across store reconstruction', async () => {
    const conversations = new FileConversationStore(join(windows.root, 'conversations'), { windows });
    await conversations.initialize();
    expect((await conversations.readCatalog()).conversations).toEqual([]);
    await conversations.writeConversation({ version: 3, conversation: {
      id: 'conv_windows', plannerSessionId: 'planner_windows', accountId: 'local-default', title: 'Windows',
      createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', archived: false, workspaceBinding: null,
    }, turns: [] });
    expect((await conversations.readConversation('conv_windows'))?.conversation.title).toBe('Windows');
    const presentation = new FileConversationPresentationStore(join(windows.root, 'presentation'), undefined, windows);
    await presentation.initialize();
    await presentation.write({ version: 1, conversationId: 'conv_windows', turns: [] });
    expect(await presentation.read('conv_windows')).toMatchObject({ version: 1, turns: [] });
    const db = new Database(':memory:');
    runMigrations(db);
    const create = () => createAccountEventJournal({ db, root: join(windows.root, 'events'),
      accountId: 'local-default', onError: error => { throw error; }, windows });
    const runtime = create();
    try {
      await runtime.journal.append({ protocolVersion: 2, accountId: 'local-default', conversationId: 'conv_windows',
        eventId: 'windows-event', turnId: 'turn_one', requestId: 'request_one', sequence: 0,
        kind: 'final_answer', occurredAt: '2026-10-08T00:00:00Z', payload: { lines: ['persisted'] } });
      await runtime.stop();
      const restored = create();
      try { expect((await restored.journal.snapshot('local-default', 'conv_windows')).lastSequence).toBe(1); }
      finally { await restored.stop(); }
    } finally { await runtime.stop(); db.close(); }
  });
  it('rolls back the complete Windows pointer set after failed candidate health', async () => {
    const names: ReleasePointerName[] = ['database', 'configuration', 'generated', 'application'];
    const paths = Object.fromEntries(names.map(name => [name, join(windows.root, 'pointers', name)])) as Record<ReleasePointerName, string>;
    windows.files.ensurePrivateDirectory(join(windows.root, 'pointers'));
    for (const version of ['old', 'new']) {
      windows.files.ensurePrivateDirectory(join(windows.root, version));
      windows.files.writePrivateFile(windows.root, `${version}\\database`, Buffer.from('database-fixture'));
      for (const name of names.slice(1)) windows.files.ensurePrivateDirectory(join(windows.root, version, name));
    }
    const targets = (version: string) => Object.fromEntries(names.map(name => [name,
      relative(dirname(paths[name]), join(windows.root, version, name))])) as Record<ReleasePointerName, string>;
    for (const name of names) windows.files.replacePrivateSymlink(windows.root, relative(windows.root, paths[name]), targets('old')[name], name !== 'database');
    const journalPath = join(windows.root, 'activation.json');
    const transaction = new ReleasePointerTransaction({ paths, journalPath, windows,
      healthCheck: async () => { throw new Error('candidate unhealthy'); } });
    await expect(transaction.activate(targets('new'))).rejects.toThrow('candidate unhealthy');
    const { readlink } = await import('node:fs/promises');
    for (const name of names) expect(await readlink(paths[name])).toBe(targets('old')[name]);
    expect(() => windows.files.readPrivateFile(windows.root, 'activation.json')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    const committed = new ReleasePointerTransaction({ paths, journalPath, windows, healthCheck: async () => undefined });
    await committed.activate(targets('new'));
    expect(await committed.recover()).toEqual({ status: 'healthy' });
  });
});
