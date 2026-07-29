import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { exportMemoryVault, showMemoryVaultStatus } from '../../src/commands/memory-commands.js';
import { showProjectProfile, showUserProfile } from '../../src/commands/profile-commands.js';
import type { CommandContext } from '../../src/commands/catalog.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('memory graph and vault commands', () => {
  let db: Database.Database;
  let memoryEngine: MemoryEngine;
  let context: CommandContext;
  let prefId: string;

  beforeEach(() => {
    db = createTestDb();
    memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    context = { memoryEngine, db } as never as CommandContext;
    const pref = memoryEngine.addManual({
      content: 'MetaClaw 文档默认使用中文，并保留执行证据',
      scope: 'project',
      type: 'style',
      subject: 'MetaClaw',
    });
    prefId = pref.id;
  });

  it('shows user and project profiles from local memory graph assets', async () => {
    const userProfile = await showUserProfile({ positionals: {}, options: {} }, context);
    expect(userProfile.content).toContain('用户工作画像');
    expect(userProfile.content).toContain('长期记忆 1');

    const projectProfile = await showProjectProfile({ positionals: { name: 'MetaClaw' }, options: {} }, context);
    expect(projectProfile.content).toContain('项目画像：MetaClaw');
    expect(projectProfile.content).toContain('MetaClaw 文档默认使用中文');
  });

  it('exports a readable one-way Markdown vault', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'metaclaw-vault-'));

    const exportResult = await exportMemoryVault({ positionals: {}, options: { dir: vaultDir } }, context);
    expect(exportResult.content).toContain('Vault 导出完成');

    expect(existsSync(join(vaultDir, 'README.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'preferences', `${prefId}.md`))).toBe(true);
    expect(existsSync(join(vaultDir, 'profiles', 'user.md'))).toBe(true);

    const prefMarkdown = readFileSync(join(vaultDir, 'preferences', `${prefId}.md`), 'utf8');
    expect(prefMarkdown).toContain('scope: project');
    expect(prefMarkdown).toContain('MetaClaw 文档默认使用中文');

    const statusResult = await showMemoryVaultStatus({ positionals: {}, options: { dir: vaultDir } }, context);
    expect(statusResult.content).toContain('preferences=1');
  });
});
