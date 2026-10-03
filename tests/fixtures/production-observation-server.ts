import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { prepareSmokeConfiguration } from '../../src/configuration/smoke-configuration.js';
import { AccountLayoutMigrator } from '../../src/installation/account-layout-migrator.js';
import { resolveMetaWorkPaths } from '../../src/installation/paths.js';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import type { ConversationMetadata, ConversationTurn } from '../../src/session/conversation-store.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { SqliteConversationMetadataIndex } from '../../src/storage/conversation-metadata-index-repo.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { stageSourceRelease } from '../../src/installation/source-native-installer.js';

/** Real CLI composition in an isolated installation; provider URLs never leave loopback. */
export async function startProductionObservationServer(options: { installed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mw-production-'));
  const repository = resolve('.');
  const paths = resolveMetaWorkPaths(undefined, root);
  let applicationRoot = repository;
  if (options.installed) {
    applicationRoot = join(paths.releases, 'observation-local-acceptance');
    await stageSourceRelease(repository, join(repository, 'planner/AnyFusion-Pi'), applicationRoot,
      'observation-local-acceptance', paths.appCurrent);
    await symlink(applicationRoot, paths.appCurrent);
  }
  await new AccountLayoutMigrator({ paths }).migrate();
  const account = resolveAccountPaths('local-default', root);
  const configHome = join(root, 'fixture-config');
  await mkdir(join(configHome, 'planner'), { recursive: true });
  await mkdir(join(configHome, 'codex'), { recursive: true });
  await writeFile(join(configHome, 'provider.env'), 'OPENAI_API_KEY=fixture-unused\nOPENAI_BASE_URL=http://127.0.0.1:1/v1\n');
  await writeFile(join(configHome, 'codex/config.toml'), 'model = "fixture-executor"\nbase_url = "http://127.0.0.1:1/v1"\n');
  await writeFile(join(configHome, 'planner/settings.json'), JSON.stringify({ defaultProvider: 'kimi', defaultModel: 'fixture-planner' }));
  await writeFile(join(configHome, 'planner/models.json'), JSON.stringify({ providers: { kimi: {
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-unused', models: [{ id: 'fixture-planner' }],
  } } }));
  await prepareSmokeConfiguration({ installRoot: root, configHome, executorCommand: 'codex',
    executorTimeoutSeconds: 60, executorMaxDurationSeconds: 60 });
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const catalog = new FileWorkspaceCatalogStore(account.workspaceCatalog);
  await catalog.initialize();
  const now = new Date().toISOString();
  await catalog.writeCatalog({ version: 1, workspaces: [{ id: 'workspace_acceptance', accountId: 'local-default',
    displayName: 'Production acceptance', canonicalPath: workspace, availability: 'available', archived: false,
    createdAt: now, updatedAt: now, createdByPrincipal: 'local' }] });
  const db = new Database(account.database);
  runMigrations(db);
  const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
  const store = new FileConversationStore(join(account.conversations, 'gateway'), {
    history, metadataIndex: new SqliteConversationMetadataIndex(db, 'local-default'),
  });
  await store.initialize();
  const metadata: ConversationMetadata[] = [];
  for (const size of [10, 100, 1000]) {
    const id = `conv_acceptance_${size}`;
    const entry: ConversationMetadata = { id, plannerSessionId: id, accountId: 'local-default',
      title: `History ${size}`, createdAt: now, updatedAt: now, archived: false,
      workspaceBinding: { workspaceId: 'workspace_acceptance', boundAt: now, boundByPrincipal: 'local' } };
    metadata.push(entry);
    await store.writeConversation({ version: 3, conversation: entry, turns: Array.from({ length: size }, (_, index) => ({
      id: `turn_${index}`, conversationId: id, status: 'completed', userInput: `Question ${size}/${index}`,
      finalAnswer: index === size - 1 ? `RESULT_${size}` : `历史 ${index}\n${'多行正文🙂\n'.repeat(1000)}${size === 10 && index === 0 ? '\nSEARCH_BEYOND_PREVIEW' : ''}`,
    })) });
  }
  await store.writeCatalog({ version: 3, conversations: metadata });
  db.close();
  const env = { ...process.env, METAWORK_INSTALL_ROOT: root, METAWORK_WEB_PORT: '0', METAWORK_NAVIGATION_DIAGNOSTICS: '1', METAWORK_SECRET_STORE: 'file',
    ANYFUSION_WEB_DIST: join(applicationRoot, 'web/dist'), ANYFUSION_WEB_USERNAME: 'acceptance',
    ANYFUSION_WEB_PASSWORD: 'fixture-password', METAWORK_CONFIG_HOME: configHome };
  delete env.ANYFUSION_INSTALL_ROOT;
  const child = spawn(process.execPath, [join(applicationRoot, 'dist/index.js'), 'server', 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const measurements: Array<{ event: string; milliseconds: number; stages: Record<string, { calls: number; items: number; bytes?: number }> }> = [];
  let outputBuffer = '';
  child.stdout.on('data', chunk => {
    log = (log + String(chunk)).slice(-16_000);
    outputBuffer += String(chunk);
    let newline: number;
    while ((newline = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, newline); outputBuffer = outputBuffer.slice(newline + 1);
      if (line.startsWith('{"event":"observation_diagnostics"') || line.startsWith('{"event":"navigation_diagnostics"')) {
        measurements.push(JSON.parse(line)); if (measurements.length > 2048) measurements.shift();
      }
    }
    if (outputBuffer.length > 16000) outputBuffer = '';
  });
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-16_000); });
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>(done => child.once('exit', () => done())), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>(done => child.once('exit', () => done()));
      }
    }
    async function unlock(directory: string): Promise<void> {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await unlock(join(directory, entry.name));
      }
    }
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('production Server exited');
      const manifest = await readFile(join(root, 'server-endpoint.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.webOrigin) return {
        root, workspace, applicationRoot, endpoint: manifest, env, port: Number(new URL(manifest.webOrigin).port), measurements, close,
        updateLatest(size: number, revision: number) {
          const writer = new Database(account.database);
          try {
            const source = new SqliteConversationHistoryRepo<ConversationTurn>(writer, 'local-default', 'conversation');
            writer.transaction(() => source.upsert(`conv_acceptance_${size}`, { id: `turn_${size - 1}`, conversationId: `conv_acceptance_${size}`,
              status: 'completed', userInput: `Question ${size}/${size - 1}`, finalAnswer: `RESULT_${size} UPDATE_${revision}` })).immediate();
          } finally { writer.close(); }
        },
      };
      await delay(100);
    }
    throw new Error('production Server startup timed out');
  } catch (error) {
    // Logs may include authentication material; expose only known diagnostic lines.
    const diagnostics = log.split('\n').filter(line => /Error:|failed|unavailable|invalid|conflict/i.test(line))
      .map(line => line.replace(/(token|key|password|secret)[=: ]+\S+/gi, '$1=[redacted]')).join('\n');
    await close();
    throw new Error(`${String(error)}\n${diagnostics}`);
  }
}
