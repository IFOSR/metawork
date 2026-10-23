import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, realpath, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

import type { LocalServiceSpecification, LocalServiceRecord, LocalServiceStore, LocalServiceView, LocalServiceOperation, LocalServiceEffect } from '../task/local-service.js';
import { publicText } from '../utils/public-text.js';
import { createServer } from 'node:net';
export type { LocalServiceSpecification, LocalServiceRecord, LocalServiceStore, LocalServiceView } from '../task/local-service.js';

export const LOCAL_SERVICE_SPECIFICATION_FILENAME = '.metawork-service.json';
export const PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION =
  `代码已发布，但任务目录中没有可启动的服务规格（${LOCAL_SERVICE_SPECIFICATION_FILENAME}）`;

const execFileAsync = promisify(execFile);
// The wrapper remains the process-group leader, so ownership survives Server
// restart. Commands never pass through a shell; the token is never a credential.
const SERVICE_HOST = `import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], JSON.parse(process.argv[3]), { stdio: 'inherit' });
child.on('error', () => process.exit(127));
child.on('exit', code => {
  // The command may have left grandchildren behind. This wrapper owns its
  // detached group; close it before losing the ownership witness.
  try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  process.exit(code ?? 1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));`;

export function validateLocalServiceSpecification(value: unknown): LocalServiceSpecification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务规格无效');
  const s = value as LocalServiceSpecification;
  if (typeof s.serviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(s.serviceId) || typeof s.taskId !== 'string' || !s.taskId
    || typeof s.command !== 'string' || !s.command || s.command.includes('\0')
    || !Array.isArray(s.args) || s.args.length > 100 || JSON.stringify(s.args).length > 32000 || s.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !['127.0.0.1', '::1'].includes(s.host) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535
    || typeof s.healthPath !== 'string' || !s.healthPath.startsWith('/') || s.healthPath.startsWith('//')
    || !Number.isInteger(s.startupTimeoutMs) || s.startupTimeoutMs < 100 || s.startupTimeoutMs > 60_000
    || s.restartPolicy !== 'explicit' || !s.environmentReferences || typeof s.environmentReferences !== 'object' || Array.isArray(s.environmentReferences)
    || Object.entries(s.environmentReferences).some(([key, ref]) => !/^[A-Z_][A-Z0-9_]*$/u.test(key)
      || ['HOST', 'PORT'].includes(key) || typeof ref !== 'string' || !ref)
    || (s.directory !== undefined && (typeof s.directory !== 'string' || isAbsolute(s.directory)
      || s.directory.split(/[\\/]/u).includes('..')))) throw new Error('服务规格无效：请检查命令、环境引用、监听地址和健康检查');
  return { serviceId: s.serviceId, taskId: s.taskId, command: s.command, args: [...s.args],
    directory: s.directory, environmentReferences: { ...s.environmentReferences }, host: s.host, port: s.port,
    healthPath: s.healthPath, startupTimeoutMs: s.startupTimeoutMs, restartPolicy: 'explicit' };
}

/** Runtime owns processes; Storage owns durable facts; Kernel authorizes calls. */
export class ManagedLocalServices {
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: {
    accountId: string;
    store: LocalServiceStore;
    logRoot: string;
    resolvePublishedDirectory(taskId: string): Promise<string | null>;
    isPublishedServiceSpecification?(taskId: string, root: string): Promise<boolean>;
    resolveEnvironment(reference: string): Promise<string | null>;
  }) {}

  find(serviceId: string): LocalServiceRecord | null { return this.deps.store.find(serviceId); }

  forTask(taskId: string): LocalServiceRecord[] {
    return this.deps.store.list().filter(record => record.accountId === this.deps.accountId && record.specification.taskId === taskId);
  }

  async readSpecification(taskId: string): Promise<LocalServiceSpecification> {
    const root = await this.deps.resolvePublishedDirectory(taskId);
    if (!root) throw new Error('代码尚未发布到用户任务目录');
    const path = join(root, LOCAL_SERVICE_SPECIFICATION_FILENAME);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION);
      }
      throw new Error('服务规格文件无效');
    }
    if (this.deps.isPublishedServiceSpecification && !await this.deps.isPublishedServiceSpecification(taskId, root)) {
      throw new Error(PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('服务规格文件无效');
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('服务规格文件无效');
    }
    const bound = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? { taskId, ...manifest } : manifest;
    const spec = validateLocalServiceSpecification(bound);
    if (spec.taskId !== taskId) throw new Error('服务规格不属于当前任务');
    return spec;
  }

  async verifyPublishedFiles(taskId: string, files: readonly { relativePath: string; contentHash: string }[]): Promise<void> {
    const root = await this.deps.resolvePublishedDirectory(taskId);
    if (!root || files.length === 0) throw new Error('缺少可核实的已交付成果');
    const canonical = await realpath(root);
    for (const file of files) {
      const path = await realpath(resolve(root, file.relativePath));
      const rel = relative(canonical, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('成果越过授权目录');
      const hash = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
      if (hash !== file.contentHash) throw new Error(`成果已改变，需要重新规划：${file.relativePath}`);
    }
  }

  async isPublished(taskId: string): Promise<boolean> { return Boolean(await this.deps.resolvePublishedDirectory(taskId)); }


  async recover(): Promise<void> {
    for (const record of this.deps.store.list()) await this.status(record.specification.serviceId);
  }

  applyAuthorizedOperation(input: { decisionId: string; operation: LocalServiceOperation;
    serviceId: string; specification?: LocalServiceSpecification }): Promise<LocalServiceEffect> {
    return this.serialize(input.serviceId, async () => {
      const store = this.deps.store;
      let effect = store.findOperation(input.decisionId);
      if (effect && (effect.serviceId !== input.serviceId || effect.operation !== input.operation)) {
        throw new Error('服务操作身份不匹配');
      }
      if (effect?.phase === 'completed') return effect;
      if (!effect) {
        effect = { decisionId: input.decisionId, serviceId: input.serviceId, operation: input.operation,
          phase: input.operation === 'start' ? 'starting' : 'stopping',
          initialToken: store.find(input.serviceId)?.processToken ?? null, result: null, error: null };
        store.saveOperation(effect);
      }
      try {
        if (effect.phase === 'stopping') {
          effect.result = await this.stopNow(input.serviceId);
          effect.phase = input.operation === 'stop' ? 'completed' : 'starting';
          effect.initialToken = null;
          store.saveOperation(effect);
        }
        if (effect.phase === 'starting') {
          const record = store.find(input.serviceId);
          // A new token proves this decision already attempted a launch. A
          // process that subsequently exited is observed, never repeated.
          effect.result = record?.processToken && record.processToken !== effect.initialToken
            ? await this.check(record)
            : await this.startNow(input.specification ?? this.require(input.serviceId).specification);
          effect.phase = 'completed';
        }
      } catch (error) {
        effect.phase = 'completed';
        effect.error = error instanceof Error ? error.message : '服务操作失败';
      }
      store.saveOperation(effect);
      return effect;
    });
  }

  start(specification: LocalServiceSpecification): Promise<LocalServiceView> {
    const spec = validateLocalServiceSpecification(specification);
    return this.serialize(spec.serviceId, () => this.startNow(spec));
  }

  private async startNow(spec: LocalServiceSpecification): Promise<LocalServiceView> {
      // Even direct Runtime calls must prove that the task directory contains
      // a valid service manifest. The authorized operation still supplies the
      // exact specification it is allowed to execute (and Kernel validates
      // its task/service identity before reaching this seam).
      await this.readSpecification(spec.taskId);
      const previous = this.deps.store.find(spec.serviceId);
      if (previous && previous.accountId !== this.deps.accountId) throw new Error('服务不存在');
      if (previous && JSON.stringify(previous.specification) !== JSON.stringify(spec)) throw new Error('服务标识已绑定其他启动规格');
      if (previous && await this.ownedProcess(previous)) return this.check(previous);
      await new Promise<void>((accept, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(spec.port, spec.host, () => probe.close(error => error ? reject(error) : accept()));
      });
      const root = await this.deps.resolvePublishedDirectory(spec.taskId);
      if (!root) throw new Error('代码尚未发布到用户任务目录，不能启动服务');
      const canonicalRoot = await realpath(root);
      const cwd = resolve(canonicalRoot, spec.directory ?? '.');
      const rel = relative(canonicalRoot, cwd);
      if (isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('服务目录超出公开任务目录');
      let parent = canonicalRoot;
      for (const segment of rel.split(sep).filter(Boolean)) {
        parent = join(parent, segment);
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('服务目录不能包含符号链接');
      }
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
        HOST: spec.host, PORT: String(spec.port) };
      for (const [key, ref] of Object.entries(spec.environmentReferences)) {
        const value = await this.deps.resolveEnvironment(ref);
        if (value === null) throw new Error(`环境引用不可用：${key}`);
        env[key] = value;
      }
      await mkdir(this.deps.logRoot, { recursive: true, mode: 0o700 });
      const token = `metawork-service-${randomUUID()}`;
      const record: LocalServiceRecord = { accountId: this.deps.accountId, specification: spec, state: 'starting',
        processId: null, processToken: token, healthMessage: '正在启动', updatedAt: new Date().toISOString() };
      this.deps.store.save(record);
      const log = await open(join(this.deps.logRoot, `${spec.serviceId}.log`), 'a', 0o600);
      try {
        const child = spawn(process.execPath, ['--input-type=module', '-e', SERVICE_HOST, token, spec.command, JSON.stringify(spec.args)],
          { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
        record.processId = child.pid!;
        child.unref();
        this.deps.store.save(record);
      } catch {
        record.state = 'failed'; record.healthMessage = '启动进程失败'; this.deps.store.save(record);
        return this.view(record);
      } finally { await log.close(); }
      const deadline = Date.now() + spec.startupTimeoutMs;
      do {
        const view = await this.check(record);
        if (view.state === 'healthy' || view.state === 'failed') return view;
        await new Promise(accept => setTimeout(accept, 100));
      } while (Date.now() < deadline);
      // A bounded startup deadline that is still unhealthy is a definite
      // failure: stop the process this task started and record the reason
      // instead of keeping "waiting for health" as a completion blocker.
      await this.stopNow(spec.serviceId);
      const timedOut = this.require(spec.serviceId);
      timedOut.state = 'failed';
      timedOut.healthMessage = 'service_health_timeout';
      timedOut.updatedAt = new Date().toISOString();
      this.deps.store.save(timedOut);
      return this.view(timedOut);
  }

  async status(serviceId: string): Promise<LocalServiceView> {
    return this.serialize(serviceId, async () => {
      const record = this.require(serviceId);
      if (record.state === 'stopped') return this.view(record);
      return this.check(record);
    });
  }

  stop(serviceId: string): Promise<LocalServiceView> {
    return this.serialize(serviceId, () => this.stopNow(serviceId));
  }

  private async stopNow(serviceId: string): Promise<LocalServiceView> {
      const record = this.require(serviceId);
      if (await this.ownedProcess(record)) {
        const group = -record.processId!;
        process.kill(group, 'SIGTERM');
        // Ownership was proved before signalling. Keep checking the group:
        // its leader may exit before a grandchild that ignores SIGTERM.
        const groupAlive = () => { try { process.kill(group, 0); return true; } catch { return false; } };
        const deadline = Date.now() + 3_000;
        while (groupAlive() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 50));
        if (groupAlive()) { try { process.kill(group, 'SIGKILL'); } catch { /* Group exited. */ } }
      }
      record.state = 'stopped'; record.healthMessage = '服务已停止，代码交付保留'; record.processId = null;
      record.processToken = null; record.updatedAt = new Date().toISOString(); this.deps.store.save(record);
      return this.view(record);
  }

  async restart(serviceId: string): Promise<LocalServiceView> {
    return this.serialize(serviceId, async () => {
      const spec = this.require(serviceId).specification;
      await this.stopNow(serviceId);
      return this.startNow(spec);
    });
  }

  async logs(serviceId: string): Promise<string> {
    const record = this.require(serviceId);
    const secrets = await Promise.all(Object.values(record.specification.environmentReferences).map(ref => this.deps.resolveEnvironment(ref)));
    const file = await open(join(this.deps.logRoot, `${serviceId}.log`), 'r').catch(() => null);
    if (!file) return '暂无服务日志';
    try {
      const size = (await file.stat()).size;
      const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
      await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      let output = bytes.toString('utf8');
      for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]');
      return publicText(output);
    } finally { await file.close(); }
  }

  private async check(record: LocalServiceRecord): Promise<LocalServiceView> {
    if (!await this.ownedProcess(record)) {
      record.state = 'failed'; record.healthMessage = '服务进程已退出，需显式重启';
    } else {
      try {
        const response = await fetch(`${this.url(record)}${record.specification.healthPath}`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        record.state = response.ok ? 'healthy' : 'unhealthy';
        record.healthMessage = response.ok ? '健康检查通过' : `服务已启动，健康检查返回 ${response.status}`;
        await response.body?.cancel();
      } catch { record.state = 'unhealthy'; record.healthMessage = '服务已启动，但尚未通过健康检查'; }
    }
    record.updatedAt = new Date().toISOString(); this.deps.store.save(record);
    return this.view(record);
  }

  private async ownedProcess(record: LocalServiceRecord): Promise<boolean> {
    if (!record.processToken) return false;
    try {
      if (!record.processId) {
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
        const line = stdout.split('\n').find(line => line.includes(record.processToken!));
        if (line) { record.processId = Number(line.trim().split(/\s/u)[0]); this.deps.store.save(record); }
      }
      if (!record.processId) return false;
      const { stdout } = await execFileAsync('ps', ['-p', String(record.processId), '-o', 'command=']);
      return stdout.includes(record.processToken);
    } catch { return false; }
  }
  private require(id: string): LocalServiceRecord {
    const record = this.deps.store.find(id);
    if (!record || record.accountId !== this.deps.accountId) throw new Error('服务不存在');
    return record;
  }
  private url(record: LocalServiceRecord): string {
    const spec = record.specification;
    return `http://${spec.host === '::1' ? '[::1]' : spec.host}:${spec.port}`;
  }
  private view(record: LocalServiceRecord): LocalServiceView {
    return { serviceId: record.specification.serviceId, taskId: record.specification.taskId,
      state: record.state, url: this.url(record), message: record.healthMessage };
  }
  private async serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw new Error('服务标识无效');
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await mkdir(this.deps.logRoot, { recursive: true, mode: 0o700 });
      const lock = join(this.deps.logRoot, `${id}.lock`);
      const deadline = Date.now() + 65_000;
      while (true) {
        try {
          await mkdir(lock, { mode: 0o700 });
          await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => '0'));
          let alive = owner > 0;
          try { if (alive) process.kill(owner, 0); } catch { alive = false; }
          const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info) continue;
          if (!alive && Date.now() - info.mtimeMs > 1000) { await rm(lock, { recursive: true, force: true }); continue; }
          if (Date.now() >= deadline) throw new Error('服务正在处理其他操作，请稍后查询状态');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
    });
    this.operations.set(id, current);
    try { return await current; } finally { if (this.operations.get(id) === current) this.operations.delete(id); }
  }
}
