import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('production composition root', () => {
  it('uses the revisioned configuration authority for storage and Executor bindings', () => {
    const index = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');
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

  it('passes the runtime binding resolver to the preserved standby TUI', () => {
    const server = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');
    expect(server).not.toContain('serverSurface');
    expect(readFileSync(resolve(root, 'src/tui/app.tsx'), 'utf8'))
      .toContain('MetaclawSession');
  });

  it('uses the local-default account paths for runtime and configuration administration', () => {
    const index = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');
    const adminStart = index.indexOf("if (cliCommand.kind === 'admin')");
    const adminEnd = index.indexOf('// Only standalone Server startup', adminStart);
    const administration = index.slice(adminStart, adminEnd);

    expect(index).toContain('resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root)');
    expect(administration).toMatch(/new FileConfigurationRepository\(\s*accountPaths\.config,\s*\)/u);
    expect(administration).toContain('secretsRoot: accountPaths.secrets');
    expect(administration).toContain("resolve(accountPaths.generated, 'agent-runtime')");
    expect(administration).not.toContain('paths.configurationRevisions');
    expect(administration).not.toContain('paths.generatedAgentRuntime');
    expect(administration).not.toContain('paths.secrets');
  });

  it('keeps Server startup independent from the user Workspace', () => {
    const index = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');
    const composition = readFileSync(
      resolve(root, 'src/account/account-runtime-composition.ts'),
      'utf8',
    );
    const workspaceServices = readFileSync(
      resolve(root, 'src/account/account-workspace-services.ts'),
      'utf8',
    );

    expect(index).not.toContain('process.cwd()');
    expect(index).toContain('userWorkspaceRoot: accountPaths.workspaceStore');
    expect(index).toContain('workspaceRoot: accountPaths.workspaceStore');
    expect(index).toContain(
      'new MarkdownPreviewServer(markdownPreviewConfig, accountPaths.workspaceStore)',
    );
    expect(composition).toContain("userWorkspaceRoot?: string");
    expect(composition).toContain('workspaceRoot: string;');
    expect(workspaceServices).toContain("'workspace-store'");
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
    const index = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');

    expect(index).toContain('verifyOwnership: authorizeConversationAttach');
    expect(index.match(/authorizeAttach: authorizeConversationAttach/g)).toHaveLength(1);
    expect(index).toContain('createInWorkspace: async (accountId, workspaceId, principalId)');
    expect(index).toContain('rememberConversation(accountId, conversation.id)');
  });

  it('runs account recovery timers and drains commands before runtime disposal', () => {
    const index = readFileSync(resolve(root, 'src/server/server-composition.ts'), 'utf8');
    const composition = readFileSync(
      resolve(root, 'src/account/account-runtime-composition.ts'),
      'utf8',
    );

    expect(index).toContain('accountRuntimeComposition.accountRuntime.reviewTaskPoolOnTimer()');
    expect(index).not.toContain('conversationRegistry.reviewTaskPoolOnTimer()');
    expect(index).toContain('clientGateway.closeAdmission()');
    expect(index).toContain('await clientGateway.drain()');
    expect(index).toContain('conversationGatewayRuntime.closeAdmission()');
    expect(index).toContain('await conversationGatewayRuntime.drain()');
    expect(index.indexOf('clientGateway.closeAdmission()'))
      .toBeLessThan(index.indexOf('conversationGatewayRuntime.closeAdmission()'));
    expect(index.indexOf('conversationGatewayRuntime.drain()'))
      .toBeLessThan(index.indexOf('plannerSupervisor.stop()'));
    expect(composition).toContain('if (deps.db.open) deps.db.close()');
  });
});
