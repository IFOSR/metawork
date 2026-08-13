import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe('buildStagedLegacyConfiguration', () => {
  it('pins test Planner and Kernel views to revision-test', () => {
    const staged = buildStagedLegacyConfiguration({
      env: {},
      testMode: true,
    });

    expect(staged.snapshot.revisionId).toBe('revision-test');
    expect(staged.planner.revisionId).toBe('revision-test');
    expect(staged.planner.routingCatalog.configurationRevision).toBe('revision-test');
    expect(staged.kernel.revisionId).toBe('revision-test');
    expect(staged.plannerBinding.configurationRevision).toBe('revision-test');
  });

  it('reads the production legacy Provider and Planner model without exposing secrets', async () => {
    const root = await legacyFixture();
    const staged = buildStagedLegacyConfiguration({
      env: { ANYFUSION_CONFIG_HOME: root },
      testMode: false,
    });

    expect(staged.snapshot.revisionId).toMatch(/^import-[a-f0-9]{24}$/u);
    expect(staged.planner.revisionId).toBe(staged.kernel.revisionId);
    expect(staged.plannerBinding).toMatchObject({
      providerRef: expect.stringMatching(/^legacy-openai-[a-f0-9]{8}$/u),
      modelRef: expect.stringMatching(/^legacy-model-[a-f0-9]{8}$/u),
      configurationRevision: staged.snapshot.revisionId,
    });
    const provider = staged.snapshot.config.providers[
      staged.plannerBinding.providerRef
    ];
    const model = staged.snapshot.config.models[staged.plannerBinding.modelRef];
    expect(provider).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      apiKeyRef: `keychain:anyfusion/imported/${staged.plannerBinding.providerRef}`,
    });
    expect(model).toMatchObject({
      providerRef: staged.plannerBinding.providerRef,
      modelId: 'legacy-model',
    });
    expect(JSON.stringify(staged)).not.toContain('sk-production-secret');
  });

  it('maps upstream model names with punctuation to stable internal references', async () => {
    const root = await legacyFixture({
      defaultProvider: 'OpenAI.Main',
      defaultModel: 'gpt-5.6/terra',
    });
    const first = buildStagedLegacyConfiguration({
      env: { ANYFUSION_CONFIG_HOME: root },
      testMode: false,
    });
    const second = buildStagedLegacyConfiguration({
      env: { ANYFUSION_CONFIG_HOME: root },
      testMode: false,
    });

    expect(first.plannerBinding).toMatchObject({
      providerRef: expect.stringMatching(/^openai-main-[a-f0-9]{8}$/u),
      modelRef: expect.stringMatching(/^gpt-5-6-terra-[a-f0-9]{8}$/u),
    });
    expect(second.plannerBinding).toEqual(first.plannerBinding);
    expect(first.snapshot.config.models[first.plannerBinding.modelRef]?.modelId)
      .toBe('gpt-5.6/terra');
  });

  it.each([
    ['Provider', { defaultProvider: '', defaultModel: 'legacy-model' }],
    ['model', { defaultProvider: 'legacy-openai', defaultModel: '' }],
  ])('fails closed when the legacy %s selection is missing', async (_, settings) => {
    const root = await legacyFixture(settings);

    expect(() => buildStagedLegacyConfiguration({
      env: { ANYFUSION_CONFIG_HOME: root },
      testMode: false,
    })).toThrow(/is missing/u);
  });
});

async function legacyFixture(settings: {
  defaultProvider: string;
  defaultModel: string;
} = {
  defaultProvider: 'legacy-openai',
  defaultModel: 'legacy-model',
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-staged-legacy-'));
  roots.push(root);
  await mkdir(join(root, 'planner'));
  await writeFile(join(root, 'provider.env'), [
    'OPENAI_API_KEY=sk-production-secret',
    'OPENAI_BASE_URL=https://api.example.com/v1',
    '',
  ].join('\n'));
  await writeFile(
    join(root, 'planner', 'settings.json'),
    JSON.stringify(settings),
  );
  return root;
}
