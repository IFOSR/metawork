import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('current client runtime topology', () => {
  it('composes one account runtime and one gateway command plane in production', () => {
    const server = source('src/server/server-composition.ts');
    expect(server).toContain('new RuntimeRegistry');
    expect(server).toContain('accountRegistry.getOrActivate');
    expect(server).toContain('new ConversationRegistry');
    expect(server).toContain('new ConversationGatewayRuntime');
    expect(server).toContain('new ClientGateway');
    expect(server).toContain('new WebGatewaySessionRuntime');
    expect(server).toContain('new FeishuGatewaySessionPort');
    expect(server).toContain('plannerHost.registerSession');
  });

  it('routes every production surface through ClientGateway', () => {
    expect(source('src/gateway/server.ts')).toContain('this.deps.gateway.handle');
    expect(source('src/management/web-gateway-session-runtime.ts'))
      .toContain('this.deps.gateway.submit');
    expect(source('src/management/server.ts')).not.toContain('SessionStreamAdapter');
    expect(source('src/management/server.ts')).not.toContain('sessionFactory');
    expect(source('src/gateway/feishu-gateway-session-port.ts'))
      .toContain('this.deps.adapter.handleMessage');
    const server = source('src/server/server-composition.ts');
    expect(server).not.toContain('ScriptedGatewaySession');
    expect(server).not.toContain('runScriptedSessionFile');
  });

  it('launches the native Planner TUI as a Gateway-only client', () => {
    const entrypoint = source('src/index.ts');
    const server = source('src/server/server-composition.ts');
    expect(entrypoint).toContain("import { runClientCommand } from './client/client-command.js'");
    expect(source('src/client/client-command.ts')).toContain('new TuiClientLauncher');
    expect(server).not.toContain('plannerSupervisor.startInteractive');
    expect(server.indexOf('new TuiClientLauncher')).toBeLessThan(server.indexOf('new ConversationGatewayRuntime'));
  });

  it('does not construct account execution services inside a Conversation factory', () => {
    const server = source('src/server/server-composition.ts');
    const factoryStart = server.indexOf('const buildConversationSession');
    const factoryEnd = server.indexOf('const conversationBindings', factoryStart);
    const factory = server.slice(factoryStart, factoryEnd);
    const composition = source('src/account/account-runtime-composition.ts');
    expect(factory).not.toContain('buildAccountKernelExecutionServices');
    expect(composition).toContain('conversationExecutionBinder');
  });
});
