import { describe, expect, it } from 'vitest';
import {
  AgentInstallationReadinessService,
  type VersionProbeResult,
} from '../../src/management/agent-installation-readiness-service.js';

function installed(stdout = 'pi 1.2.3'): VersionProbeResult {
  return { kind: 'exit', code: 0, stdout, stderr: '' };
}

describe('AgentInstallationReadinessService', () => {
  it('projects requirements from currently enabled tools, not built-in assistant names', async () => {
    let required: Array<'pi-agent' | 'codex-cli'> = ['codex-cli'];
    const service = new AgentInstallationReadinessService({
      requiredAgentIds: () => required,
      probe: async command => command === 'codex' ? installed() : { kind: 'missing' },
    });
    await service.refresh();
    expect(service.isRequiredAgentReady()).toBe(true);
    expect(service.getState().find(agent => agent.agentId === 'pi-agent')?.required).toBe(false);
    required = ['pi-agent'];
    expect(service.isRequiredAgentReady()).toBe(false);
  });

  it('reports installed agents with a bounded version and configured display name', async () => {
    const service = new AgentInstallationReadinessService({
      probe: async command => installed(`${command} ${'x'.repeat(300)}`),
      resolveDisplayName: agentId => agentId === 'pi-agent' ? '我的智能体' : '另一个智能体',
    });

    const agents = await service.refresh({ force: true });
    const pi = agents.find(agent => agent.agentId === 'pi-agent')!;

    expect(pi).toMatchObject({
      required: true,
      displayName: '我的智能体',
      status: 'installed',
    });
    expect(pi.version).toHaveLength(120);
    expect(pi.detail).toBeNull();
  });

  it('re-projects renamed agents without re-probing the installed processes', async () => {
    let piName = '智能体 1';
    let probes = 0;
    const service = new AgentInstallationReadinessService({
      probe: async command => {
        probes += 1;
        return installed(`${command} 1.2.3`);
      },
      resolveDisplayName: agentId => (agentId === 'pi-agent' ? piName : `${piName} 2`),
    });

    await service.refresh({ force: true });
    expect(probes).toBe(2);
    expect(service.getState().find(agent => agent.agentId === 'pi-agent')?.displayName)
      .toBe('智能体 1');

    // 用户在设置里改名后，投影必须立刻反映新名字，且不得重新探测进程。
    piName = '我的研究员';
    expect(service.getState().find(agent => agent.agentId === 'pi-agent')?.displayName)
      .toBe('我的研究员');
    expect(service.getState().find(agent => agent.agentId === 'codex-cli')?.displayName)
      .toBe('我的研究员 2');
    expect(probes).toBe(2);
  });

  it('publishes renamed agents to subscribers without a new probe', async () => {
    let piName = '智能体 1';
    let probes = 0;
    const service = new AgentInstallationReadinessService({
      probe: async () => {
        probes += 1;
        return installed('pi 1.2.3');
      },
      resolveDisplayName: agentId => (agentId === 'pi-agent' ? piName : undefined),
    });
    const published: string[][] = [];
    service.subscribe(agents => published.push(agents.map(agent => agent.displayName)));

    await service.refresh({ force: true });
    expect(probes).toBe(2);

    piName = 'Pi Research';
    service.republish();

    expect(published.at(-1)?.[0]).toBe('Pi Research');
    expect(probes).toBe(2);
  });

  it('distinguishes missing, timeout, non-zero, and launch-error probes', async () => {
    const service = new AgentInstallationReadinessService({
      probe: async command => {
        if (command === 'pi') return { kind: 'missing' };
        if (command === 'codex') return { kind: 'timeout' };
        return { kind: 'error', detail: 'launch failed' };
      },
    });

    const agents = await service.refresh({ force: true });
    expect(agents.find(agent => agent.agentId === 'pi-agent')).toMatchObject({
      status: 'missing',
    });
    expect(agents.find(agent => agent.agentId === 'codex-cli')).toMatchObject({
      status: 'broken',
      detail: expect.stringContaining('timed out'),
    });
  });

  it('marks non-zero exits as broken and preserves bounded redacted diagnostics', async () => {
    const service = new AgentInstallationReadinessService({
      probe: async () => ({
        kind: 'exit',
        code: 1,
        stdout: '',
        stderr: `failed with sk-secret ${'x'.repeat(500)}`,
      }),
    });

    const agents = await service.refresh({ force: true });
    expect(agents.every(agent => agent.status === 'broken')).toBe(true);
    expect(agents.every(agent => agent.detail!.length <= 240)).toBe(true);
    expect(agents.every(agent => !agent.detail!.includes('sk-secret'))).toBe(true);
  });

  it('uses one probe per command for concurrent refreshes and honors the TTL', async () => {
    let now = 1_000;
    const calls: string[] = [];
    const service = new AgentInstallationReadinessService({
      now: () => now,
      probe: async command => {
        calls.push(command);
        return installed(`${command} 1.0.0`);
      },
    });

    const first = await Promise.all([
      service.refresh({ force: true }),
      service.refresh({ force: true }),
    ]);
    expect(first[0]).toEqual(first[1]);
    expect(calls).toEqual(['pi', 'codex']);

    await service.refresh();
    expect(calls).toHaveLength(2);
    now += 30_001;
    await service.refresh();
    expect(calls).toHaveLength(4);
  });

  it('bypasses the TTL on a forced refresh and exposes required readiness', async () => {
    let now = 1_000;
    let installedPi = false;
    const service = new AgentInstallationReadinessService({
      now: () => now,
      probe: async command => command === 'pi' && !installedPi
        ? { kind: 'missing' }
        : installed(command),
    });

    await service.refresh({ force: true });
    expect(service.isRequiredAgentReady()).toBe(false);
    installedPi = true;
    now += 1;
    await service.refresh({ force: true });
    expect(service.isRequiredAgentReady()).toBe(true);
  });

  it('publishes a newer state without allowing an older refresh to overwrite it', async () => {
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    const firstPending = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const service = new AgentInstallationReadinessService({
      probe: async command => {
        call += 1;
        if (call === 1) await firstPending;
        return installed(`${command} ${call}`);
      },
    });

    const oldRefresh = service.refresh({ force: true });
    releaseFirst!();
    const newState = await service.refresh({ force: true });
    await oldRefresh;

    expect(service.getState()).toEqual(newState);
  });
});
