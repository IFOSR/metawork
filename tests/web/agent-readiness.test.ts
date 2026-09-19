import { describe, expect, it } from 'vitest';
import {
  requiredAgentBlock,
  readinessById,
} from '../../web/src/agent-readiness.js';
import type { AgentReadiness } from '../../web/src/api/types.js';

const pi = (status: AgentReadiness['status']): AgentReadiness => ({
  agentId: 'pi-agent',
  required: true,
  displayName: '智能体 1',
  status,
  version: status === 'installed' ? 'pi 1.0.0' : null,
  detail: null,
  installUrl: 'https://example.com/pi',
  checkedAt: '2026-09-16T00:00:00.000Z',
});

describe('Web Agent readiness projection', () => {
  it('checks all configured required tools instead of only the first one', () => {
    expect(requiredAgentBlock([pi('installed'), {
      ...pi('missing'), agentId: 'codex-cli', displayName: 'Codex CLI',
    }])).toMatchObject({ blocked: true, agent: { agentId: 'codex-cli' } });
    expect(requiredAgentBlock([{ ...pi('missing'), required: false }]))
      .toMatchObject({ blocked: false });
  });

  it('blocks new work until the required Pi Agent is installed', () => {
    expect(requiredAgentBlock([pi('missing')])).toEqual({
      blocked: true,
      message: '需要先安装智能体 1才能开始新工作。',
      agent: pi('missing'),
    });
    expect(requiredAgentBlock([pi('broken')]).blocked).toBe(true);
    expect(requiredAgentBlock([pi('checking')]).blocked).toBe(true);
    expect(requiredAgentBlock([pi('installed')])).toEqual({
      blocked: false,
      message: null,
      agent: pi('installed'),
    });
  });

  it('does not treat optional Codex absence as a required-agent block', () => {
    expect(requiredAgentBlock([{
      ...pi('installed'),
    }, {
      ...pi('installed'),
      agentId: 'codex-cli',
      required: false,
      displayName: '智能体 2',
      status: 'missing',
    }])).toMatchObject({ blocked: false });
    expect(readinessById([pi('installed')])['pi-agent']?.status).toBe('installed');
  });
});
