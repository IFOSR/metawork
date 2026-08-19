import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('current client runtime topology', () => {
  it('composes one account runtime and one gateway command plane in production', () => {
    const index = source('src/index.ts');
    expect(index).toContain('new RuntimeRegistry');
    expect(index).toContain('accountRegistry.getOrActivate');
    expect(index).toContain('new ConversationRegistry');
    expect(index).toContain('new ConversationGatewayRuntime');
    expect(index).toContain('new ClientGateway');
    expect(index).toContain('new WebGatewaySessionRuntime');
    expect(index).toContain('new FeishuGatewaySessionPort');
    expect(index).toContain('plannerHost.registerSession');
  });

  it('routes every production surface through ClientGateway', () => {
    expect(source('src/gateway/server.ts')).toContain('this.deps.gateway.handle');
    expect(source('src/management/web-gateway-session-runtime.ts'))
      .toContain('this.deps.gateway.submit');
    expect(source('src/management/server.ts')).not.toContain('SessionStreamAdapter');
    expect(source('src/management/server.ts')).not.toContain('sessionFactory');
    expect(source('src/gateway/feishu-gateway-session-port.ts'))
      .toContain('this.deps.adapter.handleMessage');
    expect(source('src/session/scripted-session.ts')).not.toContain('MetaclawSession');
    expect(source('src/gateway/scripted-gateway-session.ts'))
      .toContain('this.deps.gateway.handle');
    const index = source('src/index.ts');
    const scriptStart = index.indexOf("if (serverSurface === 'scripted')");
    const scriptEnd = index.indexOf("if (serverSurface === 'web')", scriptStart);
    const scriptedComposition = index.slice(scriptStart, scriptEnd);
    expect(scriptedComposition).toContain('new ScriptedGatewaySession');
    expect(scriptedComposition).not.toContain('buildConversationSession(');
  });

  it('launches the native Planner TUI as a Gateway-only client', () => {
    const index = source('src/index.ts');
    const start = index.indexOf('// 9. 启动默认 Gateway-only native TUI client.');
    const end = index.indexOf('\n}', start);
    const nativeTuiComposition = index.slice(start, end);
    expect(nativeTuiComposition).toContain('plannerSupervisor.startInteractive');
    expect(nativeTuiComposition).not.toContain('buildConversationSession(');
    expect(nativeTuiComposition).not.toContain('.submitUserInput(');
    expect(index.indexOf('await gatewayServer.start()')).toBeLessThan(start);
  });

  it('does not construct account execution services inside a Conversation factory', () => {
    const index = source('src/index.ts');
    const factoryStart = index.indexOf('const buildConversationSession');
    const factoryEnd = index.indexOf('const conversationBindings', factoryStart);
    const factory = index.slice(factoryStart, factoryEnd);
    const composition = source('src/account/account-runtime-composition.ts');
    expect(factory).not.toContain('buildAccountKernelExecutionServices');
    expect(composition).toContain('conversationExecutionBinder');
  });
});
