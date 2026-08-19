import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('production composition root', () => {
  it('uses the revisioned configuration authority for storage and Executor bindings', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const gateway = readFileSync(resolve(root, 'src/gateway/server.ts'), 'utf8');

    expect(index).toContain('createProductionSecretStore');
    expect(index).toContain('createProductionRuntimeBindings');
    expect(index).not.toContain('loadConfig(');
    expect(index).not.toContain('createSchema30MigrationContext');
    expect(index).toContain('getRuntimeBinding: runtimeBindings.getRuntimeBinding');
    // gateway/server.ts 已改为 per-Conversation：持有 ConversationRegistry + 工厂。
    expect(gateway).toContain('conversationRegistry');
    expect(gateway).toContain('conversationFactory');
    expect(gateway).toContain('getOrOpen');
  });

  it('routes native transactions through the shared installer and Server coordinator', () => {
    const installCli = readFileSync(resolve(root, 'src/install-cli.ts'), 'utf8');

    expect(installCli).toContain('InstallerCore');
    expect(installCli).toContain('ServerUpdateCoordinator');
  });
});
