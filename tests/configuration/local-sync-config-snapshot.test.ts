import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findConfigDir,
  isConsistentSnapshot,
  restoreConfig,
  revisionIsIntact,
  snapshotConfig,
} from '../../scripts/local-sync-config.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'local-sync-config-'));
  roots.push(root);
  return root;
}

/** 造一个配置目录：active 指针 + 激活日志 + 版本内容（清单含哈希）。 */
function makeConfig(
  root: string,
  options: { phase?: 'prepared' | 'committed'; previous?: string | null; next?: string; active?: string | null; tamper?: boolean } = {},
): string {
  const configDir = join(root, 'anyfusion', 'accounts', 'local-default', 'config');
  const next = options.next ?? 'rev-2';
  const previous = options.previous === undefined ? 'rev-1' : options.previous;
  const active = options.active === undefined ? next : options.active;
  // 指针可能指向上一版本（prepared 阶段），该版本目录同样必须存在。
  for (const revisionId of new Set([next, previous, active].filter((value): value is string => Boolean(value)))) {
    const revisionDir = join(configDir, 'revisions', revisionId);
    mkdirSync(revisionDir, { recursive: true });
    const content = `provider: ${revisionId}\n`;
    writeFileSync(join(revisionDir, 'providers.json'), content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(revisionDir, 'revision-manifest.json'), JSON.stringify({
      schemaVersion: 1, revisionId, contentHash: sha256,
      files: [{ path: 'providers.json', sha256: revisionId === next && options.tamper ? '0'.repeat(64) : sha256 }],
    }));
  }
  if (active !== null) writeFileSync(join(configDir, 'active'), `${active}\n`);
  if (options.phase) {
    writeFileSync(join(configDir, 'activation-journal.json'), JSON.stringify({
      phase: options.phase, previousRevisionId: previous, nextRevisionId: next, identity: 'act-1',
    }));
  }
  return configDir;
}

describe('local-sync 配置快照协调器', () => {
  it('按激活日志定位配置目录', () => {
    const root = workspace();
    const configDir = makeConfig(root, { phase: 'committed' });
    expect(findConfigDir(root)).toBe(configDir);
  });

  it('判定日志与指针的成对一致性（与仓库 recover 同口径）', () => {
    const root = workspace();
    const committed = makeConfig(root, { phase: 'committed', next: 'rev-2', active: 'rev-2' });
    expect(isConsistentSnapshot(committed)).toBe(true);
    // 撕裂：日志已提交到 rev-2，指针仍指向 rev-1。
    const torn = makeConfig(root, { phase: 'committed', next: 'rev-3', active: 'rev-1' });
    expect(isConsistentSnapshot(torn)).toBe(false);
    // prepared 阶段：指针停在上一版本或下一版本都可恢复。
    const preparedPrevious = makeConfig(root, { phase: 'prepared', previous: 'rev-1', next: 'rev-2', active: 'rev-1' });
    expect(isConsistentSnapshot(preparedPrevious)).toBe(true);
    const preparedNext = makeConfig(root, { phase: 'prepared', previous: 'rev-1', next: 'rev-2', active: 'rev-2' });
    expect(isConsistentSnapshot(preparedNext)).toBe(true);
  });

  it('校验激活版本的清单哈希（半拷贝的版本目录不算完整）', () => {
    const root = workspace();
    const intact = makeConfig(root, { phase: 'committed', next: 'rev-2', active: 'rev-2' });
    expect(revisionIsIntact(intact, 'rev-2')).toBe(true);
    const tampered = makeConfig(root, { phase: 'committed', next: 'rev-3', active: 'rev-3', tamper: true });
    expect(revisionIsIntact(tampered, 'rev-3')).toBe(false);
  });

  it('采集一致配置并原子发布；撕裂配置被丢弃且保留上一份好快照', () => {
    const root = workspace();
    const dataDir = join(root, 'data');
    const snapRoot = join(root, 'sync');
    mkdirSync(dataDir, { recursive: true });
    makeConfig(dataDir, { phase: 'committed', next: 'rev-2', active: 'rev-2' });
    expect(snapshotConfig(dataDir, snapRoot).status).toBe('published');
    expect(readFileSync(join(snapRoot, 'config', 'active'), 'utf8').trim()).toBe('rev-2');

    // 配置在提交与指针切换之间被撕裂 → 本轮丢弃，上一份好快照仍在。
    const configDir = findConfigDir(dataDir)!;
    writeFileSync(join(configDir, 'active'), 'rev-1\n');
    writeFileSync(join(configDir, 'activation-journal.json'), JSON.stringify({
      phase: 'committed', previousRevisionId: 'rev-1', nextRevisionId: 'rev-2', identity: 'act-2',
    }));
    expect(snapshotConfig(dataDir, snapRoot).status).toBe('inconsistent');
    expect(readFileSync(join(snapRoot, 'config', 'active'), 'utf8').trim()).toBe('rev-2');
  });

  it('还原时整目录替换配置，快照缺失则清空（实例仍能以 bootstrap 配置启动）', () => {
    const root = workspace();
    const dataDir = join(root, 'data');
    const snapRoot = join(root, 'sync');
    mkdirSync(dataDir, { recursive: true });
    makeConfig(dataDir, { phase: 'committed', next: 'rev-2', active: 'rev-2' });
    snapshotConfig(dataDir, snapRoot);
    // 现场配置被撕裂（模拟旧式快照里的坏副本）。
    const configDir = findConfigDir(dataDir)!;
    writeFileSync(join(configDir, 'active'), 'rev-1\n');
    expect(restoreConfig(dataDir, snapRoot).status).toBe('restored');
    expect(readFileSync(join(configDir, 'active'), 'utf8').trim()).toBe('rev-2');
    // 无快照：配置目录被清空，应用会重新播种 bootstrap 配置。
    rmSync(join(snapRoot, 'config'), { recursive: true, force: true });
    expect(restoreConfig(dataDir, snapRoot).status).toBe('no-snapshot');
    expect(findConfigDir(dataDir)).toBeNull();
  });
});
