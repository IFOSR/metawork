import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('production composition root', () => {
  it('uses the revisioned configuration authority for storage and Executor bindings', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const gatewayRuntime = readFileSync(
      resolve(root, 'src/gateway/conversation-gateway-runtime.ts'),
      'utf8',
    );

    expect(index).toContain('createProductionSecretStore');
    expect(index).toContain('createProductionRuntimeBindings');
    expect(index).not.toContain('loadConfig(');
    expect(index).not.toContain('createSchema30MigrationContext');
    expect(index).toContain('getRuntimeBinding: runtimeBindings.getRuntimeBinding');
    expect(index).toContain('new ConversationGatewayRuntime');
    expect(index).toContain('new ConversationRegistry');
    expect(gatewayRuntime).toContain('conversationFactory');
    expect(gatewayRuntime).toContain('conversations.getOrOpen');
  });

  it('uses the local-default account paths for runtime and configuration administration', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const adminStart = index.indexOf('const adminCommand = parseAdminArgs');
    const adminEnd = index.indexOf('// Every mode that reaches', adminStart);
    const administration = index.slice(adminStart, adminEnd);

    expect(index).toContain('resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root)');
    expect(administration).toMatch(/new FileConfigurationRepository\(\s*accountPaths\.config,\s*\)/u);
    expect(administration).toContain('secretsRoot: accountPaths.secrets');
    expect(administration).toContain("resolve(accountPaths.generated, 'agent-runtime')");
    expect(administration).not.toContain('paths.configurationRevisions');
    expect(administration).not.toContain('paths.generatedAgentRuntime');
    expect(administration).not.toContain('paths.secrets');
  });

  it('routes native transactions through the shared installer and Server coordinator', () => {
    const installCli = readFileSync(resolve(root, 'src/install-cli.ts'), 'utf8');
    const installer = readFileSync(
      resolve(root, 'src/installation/source-native-installer.ts'),
      'utf8',
    );
    const updater = readFileSync(
      resolve(root, 'src/installation/source-native-updater.ts'),
      'utf8',
    );

    expect(installCli).toContain('InstallerCore');
    expect(installCli).toContain('ServerUpdateCoordinator');
    expect(installCli).toContain('secretsRoot: accountPaths.secrets');
    expect(installer).toContain('resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root)');
    expect(updater).toContain('resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root)');
    expect(installer).not.toContain('paths.generatedAgentRuntime');
    expect(updater).not.toContain('paths.generatedAgentRuntime');
  });

  it('fails closed when production clients attach to an existing Conversation', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

    expect(index).toContain('verifyOwnership: authorizeConversationAttach');
    expect(index.match(/authorizeAttach: authorizeConversationAttach/g)).toHaveLength(1);
    expect(index.match(/onConversationCreated: rememberConversation/g)).toHaveLength(1);
  });

  it('runs account recovery timers and drains commands before runtime disposal', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const composition = readFileSync(
      resolve(root, 'src/account/account-runtime-composition.ts'),
      'utf8',
    );

    expect(index).toContain('accountRuntimeComposition.accountRuntime.reviewTaskPoolOnTimer()');
    expect(index).not.toContain('conversationRegistry.reviewTaskPoolOnTimer()');
    expect(index).toContain('clientGateway.closeAdmission()');
    expect(index).toContain('await runShutdownStep(() => clientGateway.drain())');
    expect(index).toContain('conversationGatewayRuntime.closeAdmission()');
    expect(index).toContain('await runShutdownStep(() => conversationGatewayRuntime.drain())');
    expect(index.indexOf('clientGateway.closeAdmission()'))
      .toBeLessThan(index.indexOf('conversationGatewayRuntime.closeAdmission()'));
    expect(index.indexOf('conversationGatewayRuntime.drain()'))
      .toBeLessThan(index.indexOf('plannerSupervisor.stop()'));
    expect(composition).toContain('if (deps.db.open) deps.db.close()');
  });
});
