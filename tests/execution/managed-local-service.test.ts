import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { ManagedLocalServices, validateLocalServiceSpecification, type LocalServiceSpecification } from '../../src/execution/managed-local-service.js';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';
import { ManagedLocalServiceRepo } from '../../src/storage/managed-local-service-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(health = '/health') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'metawork-service-')));
  const published = join(root, 'user-workspace', 'metaclaw-tasks', 'backend');
  await mkdir(published, { recursive: true });
  const db = new Database(join(root, 'state.db'));
  runMigrations(db);
  db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task', 'Service', 'Service', 'succeeded', 'now', 'now')").run();
  const port = await new Promise<number>(accept => {
    const probe = createServer(); probe.listen(0, '127.0.0.1', () => {
      const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => accept(value));
    });
  });
  await writeFile(join(published, 'server.mjs'), `import http from 'node:http';
console.log('service cwd=' + process.cwd());
http.createServer((req,res) => { res.statusCode=req.url==='/health'?200:503;res.end('ready'); }).listen(process.env.PORT,process.env.HOST);`);
  const spec: LocalServiceSpecification = { serviceId: 'backend', taskId: 'task', command: process.execPath,
    args: ['server.mjs'], environmentReferences: {}, host: '127.0.0.1', port, healthPath: health,
    startupTimeoutMs: 2000, restartPolicy: 'explicit' };
  await writeFile(join(published, '.metawork-service.json'), JSON.stringify(spec));
  const deps = { accountId: 'local-default', store: new ManagedLocalServiceRepo(db, 'local-default'),
    logRoot: join(root, 'private', 'managed-services'), resolvePublishedDirectory: async () => published,
    resolveEnvironment: async () => null };
  const manager = new ManagedLocalServices(deps);
  cleanups.push(async () => { await manager.stop('backend').catch(() => undefined); db.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, spec, deps, published, root };
}

describe('managed local service user scenarios', () => {
  it('binds a manifest without Task identity and rejects an explicit foreign Task', async () => {
    const { manager, spec, published } = await fixture();
    const { taskId: _taskId, ...manifest } = spec;
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(manifest));
    expect(await manager.readSpecification('task')).toEqual(spec);
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify({ ...manifest, taskId: 'foreign' }));
    await expect(manager.readSpecification('task')).rejects.toThrow('服务规格不属于当前任务');
  });

  it('distinguishes published code from a missing service specification', async () => {
    const { manager, spec, published, deps } = await fixture();
    await rm(join(published, '.metawork-service.json'));

    await expect(manager.readSpecification('task')).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );
    await expect(manager.start(spec)).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );

    const unpublished = new ManagedLocalServices({ ...deps, resolvePublishedDirectory: async () => null });
    await expect(unpublished.readSpecification('task')).rejects.toThrow('代码尚未发布到用户任务目录');

    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(spec));
    const unrecorded = new ManagedLocalServices({ ...deps,
      isPublishedServiceSpecification: async () => false });
    await expect(unrecorded.readSpecification('task')).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );
  });

  it('allows only an explicit update read to inspect a changed manifest revision', async () => {
    const { manager, spec, published } = await fixture();
    await manager.start(spec);
    const changed = { ...spec, args: ['changed-server.mjs'] };
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(changed));
    await expect(manager.readSpecification('task')).rejects.toThrow('需要显式的服务更新授权');
    await expect(manager.readSpecification('task', { allowRevisionChange: true })).resolves.toEqual(changed);
    await manager.stop(spec.serviceId);
  }, 10000);

  it('cleans up a background grandchild when the service command exits unexpectedly', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'child.mjs'), `import http from 'node:http';process.on('SIGTERM',()=>{});
http.createServer((req,res)=>res.end('child alive')).listen(process.env.PORT,process.env.HOST);`);
    await writeFile(join(published, 'server.mjs'), `import {spawn} from 'node:child_process';
spawn(process.execPath,['child.mjs'],{stdio:'inherit'});setTimeout(()=>process.exit(1),1500);`);
    const started = await manager.start(spec);
    expect(started.state).toBe('healthy');
    await expect.poll(async () => (await manager.status(spec.serviceId)).state, { timeout: 4000 }).toBe('failed');
    await expect(fetch(started.url + '/health')).rejects.toThrow();
  }, 10000);

  it('stops grandchildren that ignore TERM after the original service process exits', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'child.mjs'), `import http from 'node:http';process.on('SIGTERM',()=>{});
http.createServer((req,res)=>res.end('child alive')).listen(process.env.PORT,process.env.HOST);`);
    await writeFile(join(published, 'server.mjs'), `import {spawn} from 'node:child_process';
spawn(process.execPath,['child.mjs'],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
    const started = await manager.start(spec);
    expect(started.state).toBe('healthy');
    expect(await (await fetch(started.url + '/health')).text()).toBe('child alive');
    expect((await manager.stop(spec.serviceId)).state).toBe('stopped');
    await expect(fetch(started.url + '/health')).rejects.toThrow();
  }, 10000);

  it('keeps loopback binding and port under the persisted service specification', async () => {
    const { spec } = await fixture();
    for (const serviceId of [undefined, null, 123, {}, '']) {
      expect(() => validateLocalServiceSpecification({ ...spec, serviceId })).toThrow();
    }
    for (const key of ['HOST', 'PORT']) {
      expect(() => validateLocalServiceSpecification({ ...spec, environmentReferences: { [key]: 'vault:override' } })).toThrow();
    }
  });
  it('starts published code once, answers real HTTP, recovers after Server replacement, stops and restarts', async () => {
    const { manager, spec, deps, published } = await fixture();
    expect(await manager.readSpecification('task')).toEqual(spec);
    const [first, repeated] = await Promise.all([manager.start(spec), manager.start(spec)]);
    expect(first.state).toBe('healthy'); expect(repeated.state).toBe('healthy');
    const processId = manager.find('backend')!.processId;
    expect((await fetch(first.url + '/health')).status).toBe(200);
    expect(await manager.logs('backend')).toContain(published);
    const recovered = new ManagedLocalServices(deps);
    await recovered.recover();
    expect((await recovered.status('backend')).state).toBe('healthy');
    await recovered.start(spec);
    expect(recovered.find('backend')!.processId).toBe(processId);
    expect(JSON.stringify(first)).not.toContain(String(processId));
    expect((await recovered.stop('backend')).state).toBe('stopped');
    await expect(fetch(first.url + '/health')).rejects.toThrow();
    expect((await recovered.restart('backend')).state).toBe('healthy');
    expect(recovered.find('backend')!.processId).not.toBe(processId);
  }, 15000);

  it('records a bounded startup timeout as a definite failure and stops the process', async () => {
    const { manager, spec } = await fixture('/missing');
    const result = await manager.start(spec);
    // Health never passed inside startupTimeoutMs: the task-owned start is a
    // definite failure and its process is stopped, never left half-running.
    expect(result.state).toBe('failed');
    expect(result.message).toBe('service_health_timeout');
    expect(manager.find('backend')?.processId ?? null).toBeNull();
  });

  it('refuses an occupied port and an unpublished task', async () => {
    const { manager, spec, deps } = await fixture();
    await manager.start(spec);
    // Publication refusal is checked with a fresh service ID, before any command runs.
    const unavailable = new ManagedLocalServices({ ...deps, resolvePublishedDirectory: async () => null });
    await expect(unavailable.start({ ...spec, serviceId: 'unpublished', port: spec.port + 1 })).rejects.toThrow('尚未发布');
    await expect(manager.start({ ...spec, serviceId: 'occupied' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});


describe('durable authorized service operations', () => {
  it('serializes two Runtime managers and replays a restart decision without a second launch', async () => {
    const { manager, spec, deps } = await fixture();
    const replacement = new ManagedLocalServices(deps);
    await Promise.all([manager.start(spec), replacement.start(spec)]);
    const first = manager.find(spec.serviceId)!.processId;
    const request = { decisionId: 'restart-once', operation: 'restart' as const, serviceId: spec.serviceId };
    const result = await manager.applyAuthorizedOperation(request);
    const restarted = manager.find(spec.serviceId)!;
    expect(result.result?.state).toBe('healthy');
    expect(restarted.processId).not.toBe(first);
    expect(await replacement.applyAuthorizedOperation(request)).toEqual(result);
    expect(replacement.find(spec.serviceId)!.processId).toBe(restarted.processId);
    // Simulate loss of the final journal write after the process was launched.
    deps.store.saveOperation({ ...result, phase: 'starting', initialToken: null, result: null });
    expect((await replacement.applyAuthorizedOperation(request)).result?.state).toBe('healthy');
    expect(replacement.find(spec.serviceId)!.processId).toBe(restarted.processId);
  }, 15000);

  it('survives actual Server process exit and is rediscovered without spawning again', async () => {
    const { manager, spec, deps, root, published } = await fixture();
    // Compile only the Runtime adapter for a real, independent Server process.
    for (const source of ['core/local-service-revision', 'execution/managed-local-service', 'storage/managed-local-service-repo', 'task/local-service', 'utils/public-text', 'utils/redact-sensitive-text']) {
      const target = join(root, 'compiled', source + '.js');
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, ts.transpileModule(await readFile(join(process.cwd(), 'src', source + '.ts'), 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    }
    await writeFile(join(root, 'compiled', 'package.json'), '{"type":"module"}');
    const script = join(root, 'compiled', 'server.mjs');
    await writeFile(script, `import Database from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/better-sqlite3/lib/index.js')).href)};
import { ManagedLocalServices } from './execution/managed-local-service.js';
import { ManagedLocalServiceRepo } from './storage/managed-local-service-repo.js';
const db = new Database(${JSON.stringify(join(root, 'state.db'))});
const manager = new ManagedLocalServices({ accountId: 'local-default', store: new ManagedLocalServiceRepo(db, 'local-default'),
logRoot: ${JSON.stringify(deps.logRoot)}, resolvePublishedDirectory: async () => ${JSON.stringify(published)}, resolveEnvironment: async () => null });
const result = await manager.applyAuthorizedOperation(${JSON.stringify({ decisionId: 'server-start', serviceId: spec.serviceId, operation: 'start', specification: spec })});
console.log(JSON.stringify(result)); db.close(); process.exit(0);`);
    const { stdout } = await promisify(execFile)(process.execPath, [script]);
    expect(JSON.parse(stdout).result.state).toBe('healthy');
    const pid = manager.find(spec.serviceId)!.processId;
    await manager.recover();
    expect((await manager.status(spec.serviceId)).state).toBe('healthy');
    expect((await manager.applyAuthorizedOperation({ decisionId: 'server-start', serviceId: spec.serviceId,
      operation: 'start', specification: spec })).result?.state).toBe('healthy');
    expect(manager.find(spec.serviceId)!.processId).toBe(pid);
    expect((await manager.stop(spec.serviceId)).state).toBe('stopped');
  }, 15000);

  it('records a failed command truthfully and does not silently retry a completed decision', async () => {
    const { manager, spec } = await fixture();
    const request = { decisionId: 'failed-start', operation: 'start' as const, serviceId: spec.serviceId,
      specification: { ...spec, command: 'metawork-command-that-does-not-exist' } };
    const result = await manager.applyAuthorizedOperation(request);
    expect(result.result?.state).toBe('failed');
    const token = manager.find(spec.serviceId)!.processToken;
    expect(await manager.applyAuthorizedOperation(request)).toEqual(result);
    expect(manager.find(spec.serviceId)!.processToken).toBe(token);
  });

  it('persists an explicitly authorized specification update after the service is stopped', async () => {
    const { manager, spec } = await fixture();
    await manager.start(spec);
    await manager.stop(spec.serviceId);
    const changed = { ...spec, args: ['updated-server.mjs'] };
    const result = await manager.applyAuthorizedOperation({
      decisionId: 'update-once',
      operation: 'update',
      serviceId: spec.serviceId,
      specification: changed,
    });
    expect(result.error).toBeNull();
    expect(manager.find(spec.serviceId)?.specification).toEqual(changed);
    expect(manager.find(spec.serviceId)?.specificationRevision).toBe(localServiceSpecificationRevision(changed));
    expect(manager.find(spec.serviceId)?.state).toBe('stopped');
  });

  it('redacts referenced secrets and internal paths in service logs', async () => {
    const { spec, deps, published } = await fixture();
    await writeFile(join(published, 'server.mjs'), `console.log(process.env.SERVICE_SECRET);console.log('/private/runtime/workspace-store/workspaces/task/attempts/run/log');
import http from 'node:http';http.createServer((req,res)=>res.end('ok')).listen(process.env.PORT,process.env.HOST);`);
    const manager = new ManagedLocalServices({ ...deps, resolveEnvironment: async () => 'sensitive-test-value' });
    await manager.start({ ...spec, environmentReferences: { SERVICE_SECRET: 'vault:test' } });
    const logs = await manager.logs(spec.serviceId);
    expect(logs).not.toContain('sensitive-test-value'); expect(logs).not.toContain('workspace-store');
    expect(logs).toContain('[内部路径]');
  });
});
