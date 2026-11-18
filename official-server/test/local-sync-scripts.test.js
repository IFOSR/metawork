// local-sync 数据模式的 Pod 内脚本生命周期演练：用真实 SQLite/node:sqlite、
// git 与文件系统执行渲染出的同步/恢复脚本，验证四条数据路径——
// 重新部署（Pod 重建）、版本更新（同重建）、停机恢复、Pod 删除（无 preStop）。
// 测试统一在 WSL/Linux 执行；无 sh 的环境跳过（Windows 属未维护平台 ADR-0055 D13）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandboxRestoreScript, sandboxSyncOnceScript } from '../sandbox-scripts.js';

const shAvailable = spawnSync('sh', ['-c', 'true']).status === 0;
const sh = script => {
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`script failed (${result.status}):\n${result.stderr}\n${script}`);
  return result;
};
const workspace = 'rt_abc123def456';
const resource = 'mw-rt-abc123def456';

function makeDataDir(root) {
  const data = join(root, 'data');
  mkdirSync(join(data, 'accounts', 'acct_1', 'data'), { recursive: true });
  // SQLite：WAL 模式写入一行，验证 backup API 快照的自含性与可打开性。
  const db = new DatabaseSync(join(data, 'accounts', 'acct_1', 'data', 'anyfusion.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('first');
  db.close();
  // git 工作区：一个带提交的仓库。
  const repo = join(data, 'workspace', 'demo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'hello');
  const git = (args) => {
    const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
    return run.stdout;
  };
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const head = git(['rev-parse', 'HEAD']).trim();
  // 普通文件（记忆/附件类）。
  mkdirSync(join(data, 'accounts', 'acct_1', 'memory'), { recursive: true });
  writeFileSync(join(data, 'accounts', 'acct_1', 'memory', 'note.md'), 'memory doc');
  return { data, repo, head, git };
}

function openSnapshotDb(root, relative) {
  return new DatabaseSync(join(root, 'sync', resource, 'db', relative), { readOnly: true });
}

test('sync captures a consistent sqlite backup, git mirror and plain files', { skip: !shAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'local-sync-'));
  try {
    process.env.SANDBOX_DATA_DIR = join(root, "data");
    process.env.SANDBOX_SYNC_ROOT = join(root, "sync");
    const { repo, head } = makeDataDir(root);
    sh(sandboxSyncOnceScript(resource));
    // SQLite 快照可打开且内容完整（WAL 已并入主文件）。
    const snapshot = openSnapshotDb(root, join('accounts', 'acct_1', 'data', 'anyfusion.db'));
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
    snapshot.close();
    // git 镜像包含当前 HEAD。
    const mirror = join(root, 'sync', resource, 'git', readdirSync(join(root, 'sync', resource, 'git')).find(name => name.endsWith('.git')));
    const mirrorHead = spawnSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(mirrorHead.status, 0);
    assert.equal(mirrorHead.stdout.trim(), head);
    // 普通文件进了 rest/。
    assert.equal(readFileSync(join(root, 'sync', resource, 'rest', join('accounts', 'acct_1', 'memory', 'note.md')), 'utf8'), 'memory doc');
  } finally {
    delete process.env.SANDBOX_DATA_DIR;
    delete process.env.SANDBOX_SYNC_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rebuilds an empty data dir; a non-empty one (crash restart) is left untouched', { skip: !shAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'local-sync-'));
  try {
    process.env.SANDBOX_DATA_DIR = join(root, "data");
    process.env.SANDBOX_SYNC_ROOT = join(root, "sync");
    const { data } = makeDataDir(root);
    sh(sandboxSyncOnceScript(resource));
    // ── 场景：重新部署 / 版本更新 / 停机恢复 —— Pod 重建后本地目录为空，恢复。 ──
    const fresh = join(root, 'data-fresh');
    mkdirSync(fresh, { recursive: true });
    process.env.SANDBOX_DATA_DIR = fresh;
    sh(sandboxRestoreScript(resource));
    const restoredDb = new DatabaseSync(join(fresh, 'accounts', 'acct_1', 'data', 'anyfusion.db'), { readOnly: true });
    assert.equal(restoredDb.prepare('SELECT body FROM notes').get().body, 'first');
    restoredDb.close();
    assert.equal(readFileSync(join(fresh, 'accounts', 'acct_1', 'memory', 'note.md'), 'utf8'), 'memory doc');
    assert.ok(readdirSync(join(fresh, 'workspace', 'demo')).includes('a.txt'));
    // ── 场景：容器崩溃后重启 —— emptyDir 随 Pod 保留，本地非空，恢复必须不动它。 ──
    process.env.SANDBOX_DATA_DIR = data;
    writeFileSync(join(data, 'local-only.txt'), 'kept');
    sh(sandboxRestoreScript(resource));
    assert.equal(readFileSync(join(data, 'local-only.txt'), 'utf8'), 'kept');
  } finally {
    delete process.env.SANDBOX_DATA_DIR;
    delete process.env.SANDBOX_SYNC_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('preStop final sync carries the last writes across pod recreation; a hard pod kill loses only the unsynced delta (RPO)', { skip: !shAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'local-sync-'));
  try {
    process.env.SANDBOX_DATA_DIR = join(root, "data");
    process.env.SANDBOX_SYNC_ROOT = join(root, "sync");
    const { data, repo, git } = makeDataDir(root);
    sh(sandboxSyncOnceScript(resource));
    // 周期同步之后又发生写入（模拟最后一次同步与 Pod 终止之间的增量）。
    const db = new DatabaseSync(join(data, 'accounts', 'acct_1', 'data', 'anyfusion.db'));
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('second');
    db.close();
    writeFileSync(join(repo, 'a.txt'), 'hello v2');
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v2']);
    const head2 = git(['rev-parse', 'HEAD']).trim();
    // ── 场景：停机 / 版本更新 —— preStop 在终止前强制同步一次（等价于再跑一遍 sync-once）。 ──
    sh(sandboxSyncOnceScript(resource));
    // 场景 A：Pod 删除后重建（更新/停机恢复），本地目录为空 → 恢复含最后写入。
    const fresh = join(root, 'data-after-prestop');
    mkdirSync(fresh, { recursive: true });
    process.env.SANDBOX_DATA_DIR = fresh;
    sh(sandboxRestoreScript(resource));
    const dbA = new DatabaseSync(join(fresh, 'accounts', 'acct_1', 'data', 'anyfusion.db'), { readOnly: true });
    assert.deepEqual(dbA.prepare('SELECT body FROM notes ORDER BY id').all().map(row => row.body), ['first', 'second']);
    dbA.close();
    const mirror = join(root, 'sync', resource, 'git', readdirSync(join(root, 'sync', resource, 'git')).find(name => name.endsWith('.git')));
    assert.equal(spawnSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), head2);
    // ── 场景：Pod 被硬删 / 节点故障 —— 无 preStop，最后一次写入不在快照里。 ──
    // preStop 同步之后又写入 'third'（未及同步），Pod 被硬删。
    const dbLate = new DatabaseSync(join(data, 'accounts', 'acct_1', 'data', 'anyfusion.db'));
    dbLate.prepare('INSERT INTO notes (body) VALUES (?)').run('third');
    dbLate.close();
    const afterKill = join(root, 'data-after-kill');
    mkdirSync(afterKill, { recursive: true });
    process.env.SANDBOX_DATA_DIR = afterKill;
    sh(sandboxRestoreScript(resource));
    const dbB = new DatabaseSync(join(afterKill, 'accounts', 'acct_1', 'data', 'anyfusion.db'), { readOnly: true });
    assert.deepEqual(dbB.prepare('SELECT body FROM notes ORDER BY id').all().map(row => row.body), ['first', 'second']);
    dbB.close();
    // 有损但不丢库：preStop 覆盖内的 'second' 在，未同步的 'third' 丢——RPO = 同步间隔。
  } finally {
    delete process.env.SANDBOX_DATA_DIR;
    delete process.env.SANDBOX_SYNC_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});
