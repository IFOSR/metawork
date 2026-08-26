import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductRootMigrator } from '../../src/installation/product-root-migrator.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ProductRootMigrator', () => {
  it('does nothing when no legacy installation exists', async () => {
    const home = temporaryHome('not-needed');

    const migration = await new ProductRootMigrator({ userHome: home }).prepare();

    expect(migration.outcome).toBe('not_needed');
    expect(migration.paths.root).toBe(join(home, '.metawork'));
  });

  it('copies and verifies legacy state before archiving the old root', async () => {
    const home = temporaryHome('commit');
    const legacyRoot = seedLegacyRoot(home);

    const migration = await new ProductRootMigrator({
      userHome: home,
      now: () => '2026-08-26T12:34:56.000Z',
    }).prepare();

    expect(migration.outcome).toBe('prepared');
    expect(readFileSync(join(migration.paths.root, 'app', 'releases', '1', 'dist', 'index.js'), 'utf8'))
      .toBe('runtime\n');
    expect(readFileSync(join(migration.paths.root, 'accounts', 'local-default', 'planner', 'sessions', 'session.jsonl'), 'utf8'))
      .toBe('session\n');
    expect(readlinkSync(join(migration.paths.root, 'app', 'current'))).toBe('releases/1');
    expect(existsSync(join(migration.paths.root, 'data', 'runtime.lock'))).toBe(false);
    expect(existsSync(join(migration.paths.root, 'data', 'gateway.sock'))).toBe(false);

    await migration.commit();

    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(`${legacyRoot}.migrated-2026-08-26T12-34-56-000Z`)).toBe(true);
    expect(existsSync(migration.paths.root)).toBe(true);
    for (const launcherPath of [
      migration.paths.launcher,
      migration.paths.anyFusionLauncher,
      migration.paths.metaclawLauncher,
    ]) {
      expect(readFileSync(launcherPath, 'utf8')).toContain(
        `ANYFUSION_INSTALL_ROOT:-${migration.paths.root}`,
      );
    }
  });

  it('refuses migration while the legacy runtime lock is live', async () => {
    const home = temporaryHome('locked');
    const legacyRoot = seedLegacyRoot(home);
    writeFileSync(
      join(legacyRoot, 'data', 'runtime.lock'),
      `{"pid":"${process.pid}","startedAt":"2026-08-26T00:00:00.000Z"}\n`,
    );

    await expect(new ProductRootMigrator({ userHome: home }).prepare())
      .rejects.toThrow('legacy AnyFusion Server is still running');
    expect(existsSync(join(home, '.metawork'))).toBe(false);
  });

  it('fails closed when both roots contain unjournaled state', async () => {
    const home = temporaryHome('mixed');
    seedLegacyRoot(home);
    mkdirSync(join(home, '.metawork'), { recursive: true });
    writeFileSync(join(home, '.metawork', 'unexpected'), 'state\n');

    await expect(new ProductRootMigrator({ userHome: home }).prepare())
      .rejects.toThrow('both legacy AnyFusion and MetaWork roots contain state');
  });

  it('removes staging and preserves the legacy authority when verification fails', async () => {
    const home = temporaryHome('verification');
    const legacyRoot = seedLegacyRoot(home);

    await expect(new ProductRootMigrator({
      userHome: home,
      verifyCandidate: async () => {
        throw new Error('candidate rejected');
      },
    }).prepare()).rejects.toThrow('candidate rejected');

    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(join(home, '.metawork'))).toBe(false);
    expect(existsSync(join(home, '.metawork-root-migration.json'))).toBe(false);
  });

  it('removes an activated candidate and preserves the legacy root on rollback', async () => {
    const home = temporaryHome('rollback');
    const legacyRoot = seedLegacyRoot(home);
    const migration = await new ProductRootMigrator({ userHome: home }).prepare();

    await migration.rollback();

    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(migration.paths.root)).toBe(false);
    expect(existsSync(join(home, '.metawork-root-migration.json'))).toBe(false);
  });

  it('recovers an activated migration journal deterministically', async () => {
    const home = temporaryHome('recovery');
    const legacyRoot = seedLegacyRoot(home);
    const first = await new ProductRootMigrator({ userHome: home }).prepare();
    expect(first.outcome).toBe('prepared');

    const recovered = await new ProductRootMigrator({ userHome: home }).prepare();
    expect(recovered.outcome).toBe('prepared');
    expect(readFileSync(join(recovered.paths.root, 'accounts', 'local-default', 'results', 'result.txt'), 'utf8'))
      .toBe('result\n');

    await recovered.rollback();
    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(recovered.paths.root)).toBe(false);
  });
});

function temporaryHome(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `metawork-root-${name}-`));
  cleanup.push(root);
  return root;
}

function seedLegacyRoot(home: string): string {
  const root = join(home, '.anyfusion');
  for (const directory of [
    join(root, 'app', 'releases', '1', 'dist'),
    join(root, 'data'),
    join(root, 'accounts', 'local-default', 'planner', 'sessions'),
    join(root, 'accounts', 'local-default', 'conversations'),
    join(root, 'accounts', 'local-default', 'workspace-store'),
    join(root, 'accounts', 'local-default', 'attempts'),
    join(root, 'accounts', 'local-default', 'results'),
    join(root, 'accounts', 'local-default', 'secrets'),
    join(root, 'accounts', 'local-default', 'generated'),
    join(root, 'upgrade-journals'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(root, 'app', 'releases', '1', 'dist', 'index.js'), 'runtime\n');
  symlinkSync('releases/1', join(root, 'app', 'current'));
  writeFileSync(
    join(root, 'accounts', 'local-default', 'planner', 'sessions', 'session.jsonl'),
    'session\n',
  );
  writeFileSync(join(root, 'accounts', 'local-default', 'conversations', 'conversation.json'), '{}\n');
  writeFileSync(join(root, 'accounts', 'local-default', 'workspace-store', 'workspace.txt'), 'workspace\n');
  writeFileSync(join(root, 'accounts', 'local-default', 'attempts', 'attempt.txt'), 'attempt\n');
  writeFileSync(join(root, 'accounts', 'local-default', 'results', 'result.txt'), 'result\n');
  writeFileSync(join(root, 'accounts', 'local-default', 'secrets', 'secret.ref'), 'reference\n');
  writeFileSync(join(root, 'accounts', 'local-default', 'generated', 'runtime.txt'), 'generated\n');
  writeFileSync(join(root, 'upgrade-journals', 'journal.json'), '{}\n');
  writeFileSync(join(root, 'data', 'runtime.lock'), '{"pid":"999999"}\n');
  writeFileSync(join(root, 'data', 'gateway.sock'), 'ephemeral\n');
  return root;
}
