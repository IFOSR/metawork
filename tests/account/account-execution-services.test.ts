import { describe, expect, it } from 'vitest';
import { buildAccountExecutionServices } from '../../src/account/account-execution-services.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { PiCompositeExecutorAdapter } from '../../src/executor/pi-composite-executor-adapter.js';

describe('AccountExecutionServices', () => {
  it('builds the pi-agent Executor as a composite standard-Pi/image adapter', async () => {
    const stagedConfiguration = buildStagedLegacyConfiguration({ testMode: true });
    const services = buildAccountExecutionServices({
      stagedConfiguration,
      getRuntimeBinding: binding => ({
        revisionId: binding.configurationRevision,
        bindingFingerprint: 'test-fingerprint',
        environment: {
          OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
          OPENAI_API_KEY: 'test-secret',
          OPENAI_MODEL: 'test-model',
        },
      }),
      attemptExecutionBackend: {
        kind: 'worktree',
        pathMode: 'native',
      } as never,
      attemptExecutionRepository: {} as never,
      attemptsRoot: '/tmp/metawork-account-execution-services',
    });

    const binding = services.executorRegistry.bindingForAgentClass(
      'pi-agent',
      stagedConfiguration.snapshot.revisionId,
    );
    expect(binding).not.toBeNull();
    const adapter = await services.executorRegistry.resolve(binding!);

    expect(adapter).toBeInstanceOf(PiCompositeExecutorAdapter);
    expect(adapter?.name).toBe('pi-agent');
    expect(services.executorRegistry.supportsResponseOnly(
      'pi-agent',
      stagedConfiguration.snapshot.revisionId,
    )).toBe(true);
  });
});
