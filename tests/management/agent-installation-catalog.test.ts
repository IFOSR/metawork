import { describe, expect, it } from 'vitest';
import {
  agentClassRefForInstallation,
} from '../../src/management/agent-installation-catalog.js';

const HARNESSES = {
  'pi-cli': { transport: 'local-cli', command: 'pi' },
  'codex-cli': { transport: 'local-cli', command: 'codex' },
  'anyfusion-planner': { transport: 'local-process', commandRef: 'release:planner' },
};

describe('agentClassRefForInstallation', () => {
  it('maps an installation to the AgentClass that runs its command', () => {
    const agentClasses = {
      'pi-research': { harnessRef: 'pi-cli' },
      'codex-engineering': { harnessRef: 'codex-cli' },
      planner: { harnessRef: 'anyfusion-planner' },
    };

    expect(agentClassRefForInstallation({
      agentId: 'pi-agent',
      agentClasses,
      harnesses: HARNESSES,
    })).toBe('pi-research');
    expect(agentClassRefForInstallation({
      agentId: 'codex-cli',
      agentClasses,
      harnesses: HARNESSES,
    })).toBe('codex-engineering');
  });

  it('resolves legacy AgentClass references that reuse the installation id', () => {
    const agentClasses = {
      'pi-agent': { harnessRef: 'pi-cli' },
      'codex-cli': { harnessRef: 'codex-cli' },
    };

    expect(agentClassRefForInstallation({
      agentId: 'pi-agent',
      agentClasses,
      harnesses: HARNESSES,
    })).toBe('pi-agent');
    expect(agentClassRefForInstallation({
      agentId: 'codex-cli',
      agentClasses,
      harnesses: HARNESSES,
    })).toBe('codex-cli');
  });

  it('returns null when no AgentClass runs the installation command', () => {
    expect(agentClassRefForInstallation({
      agentId: 'pi-agent',
      agentClasses: { planner: { harnessRef: 'anyfusion-planner' } },
      harnesses: HARNESSES,
    })).toBeNull();
  });

  it('ignores non local-cli harnesses and missing harness references', () => {
    expect(agentClassRefForInstallation({
      agentId: 'codex-cli',
      agentClasses: {
        planner: { harnessRef: 'anyfusion-planner' },
        ghost: { harnessRef: 'missing-harness' },
      },
      harnesses: HARNESSES,
    })).toBeNull();
  });

  it('is deterministic when several AgentClasses share one installation', () => {
    const agentClasses = {
      'zeta-pi': { harnessRef: 'pi-cli' },
      'alpha-pi': { harnessRef: 'pi-cli' },
    };

    expect(agentClassRefForInstallation({
      agentId: 'pi-agent',
      agentClasses,
      harnesses: HARNESSES,
    })).toBe('alpha-pi');
  });
});
