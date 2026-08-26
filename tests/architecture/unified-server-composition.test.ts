import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';

function mockCoordinator(): AccountKernelCoordinator {
  return {
    submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
    recover: async () => ({
      decisions: [],
      quiescent: true,
      pendingRecovery: 0,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
    }),
  };
}

describe('unified server composition', () => {
  it('hosts one gateway core, adapters, registry and account runtime together', async () => {
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => mockCoordinator(),
      recoverDurableStartup: async () => undefined,
    });
    const registry = new RuntimeRegistry({ factory });
    const subscriptions = new GatewaySubscriptions();
    const journal = new FileEventJournal('/tmp/anyfusion-unified-composition-journal');
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: LOCAL_DEFAULT_ACCOUNT_ID }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ requestId: 'req', idempotencyKey: 'idem', status: 'accepted' }),
    });
    const webAdapter = new WebGatewayAdapter({ gateway, journal, subscriptions });
    const feishuAdapter = new FeishuGatewayAdapter({ gateway });

    const runtime = await registry.getOrActivate({
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      authorized: true,
    });
    expect(runtime.accountId).toBe(LOCAL_DEFAULT_ACCOUNT_ID);

    // 所有组件在一个进程中共存。
    expect(registry).toBeDefined();
    expect(gateway).toBeDefined();
    expect(webAdapter).toBeDefined();
    expect(feishuAdapter).toBeDefined();
    expect(subscriptions).toBeDefined();
    expect(registry.getIfLoaded(LOCAL_DEFAULT_ACCOUNT_ID)).toBe(runtime);
  });

  it('has zero client-owned runtime instances in the composition model', () => {
    expect(clientOwnedRuntimeConstructors()).toEqual([]);
  });

  it('asserts the actual production composition root activates the registry', () => {
    const index = readFileSync(join(process.cwd(), 'src', 'server', 'server-composition.ts'), 'utf8');
    expect(index).toContain('accountRegistry.getOrActivate');
    expect(index).toContain('new ConversationGatewayRuntime');
    expect(index).toContain('new ClientGateway');
    expect(index).not.toContain('new MetaclawSession');
  });

  it('starts shared adapters before selecting the foreground client', () => {
    const index = readFileSync(join(process.cwd(), 'src', 'server', 'server-composition.ts'), 'utf8');
    const sharedStart = index.indexOf('await gatewayServer.start()');
    const foregroundSelection = index.indexOf('const taskArtifactRepo = new TaskArtifactRepo');

    expect(sharedStart).toBeGreaterThan(0);
    expect(foregroundSelection).toBeGreaterThan(sharedStart);
    expect(index.slice(sharedStart, foregroundSelection)).toContain('gatewayFeishuManager.applyConfiguration');
    expect(index).not.toContain('startInteractive');
    expect(index).not.toContain('open(');
  });
});

function clientOwnedRuntimeConstructors(): string[] {
  // 真实扫描：客户端适配器（gateway/management/integrations/tui-bridge）
  // 不得构造 AccountRuntime 或 Kernel/Execution/Workflow 服务。
  const roots = ['gateway', 'management', 'integrations', 'tui-bridge'];
  const violations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts')) {
        const content = readFileSync(full, 'utf8');
        if (/new\s+(AccountRuntime|KernelExecutionRuntime|DurableKernelWorkflow|ControlKernel|ExecutionRuntime)\s*\(/.test(content)) {
          violations.push(relative(join(process.cwd(), 'src'), full));
        }
      }
    }
  };
  for (const root of roots) {
    walk(join(process.cwd(), 'src', root));
  }
  return violations;
}
