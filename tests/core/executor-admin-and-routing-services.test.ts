import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorAdminService } from '../../src/executor/executor-admin-service.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('agent class admin and planner dispatch services', () => {
  it('owns executor AgentClass register wizard state and persists classes without session logic', async () => {
    const db = createDb();
    const agentClassService = new AgentClassService({
      db,
      defaultExecutorName: 'codex-cli',
      availableCommands: new Set(['codex']),
    });
    const service = new ExecutorAdminService({
      agentClassService,
      presentation: new SessionPresentationService(),
      fetchText: vi.fn(),
    });

    expect(service.startWizard().join('\n')).toContain('Executor AgentClass name');
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('manual');
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('run --prompt {prompt}');
    await service.handlePendingWizardInput('research-bot --version');
    await service.handlePendingWizardInput('research,reporting');
    await service.handlePendingWizardInput('research,report_generation');
    const result = await service.handlePendingWizardInput('y');

    expect(result.handled).toBe(true);
    expect(result.lines.join('\n')).toContain('Registered Executor AgentClass: research-bot');
    expect(service.hasPendingWizard()).toBe(false);
    expect(agentClassService.findByName('research-bot')).toMatchObject({
      name: 'research-bot',
      kind: 'executor',
      runtimeCommand: 'research-bot',
      runtimeArgs: ['run', '--prompt', '{prompt}'],
      runtimeCheckCommand: 'research-bot --version',
      domains: ['research', 'reporting'],
      capabilities: ['research', 'report_generation'],
    });
    expect(new WorkUnitRepo(db).findAll().filter(unit => unit.agentClassName === 'research-bot')).toEqual([]);
  });

  it('infers package runtime from project URL inside the admin service', async () => {
    const db = createDb();
    const service = new ExecutorAdminService({
      agentClassService: new AgentClassService({
        db,
        defaultExecutorName: 'codex-cli',
        availableCommands: new Set(['codex']),
      }),
      presentation: new SessionPresentationService(),
      fetchText: vi.fn(async url => url.endsWith('/package.json')
        ? JSON.stringify({ name: '@acme/research-bot', bin: { 'research-bot': './bin.js' } })
        : null),
    });

    service.startWizard();
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('url');
    const result = await service.handlePendingWizardInput('https://github.com/acme/research-bot');

    expect(result.lines.join('\n')).toContain('command=research-bot');
    expect(result.lines.join('\n')).toContain('check=research-bot --version');
  });
});
