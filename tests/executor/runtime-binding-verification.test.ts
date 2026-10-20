import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeRenderer, executorRuntimeConfiguration } from '../../src/configuration/agent-runtime-renderer.js';
import type { AnyFusionConfigurationV2, RuntimePrivateConfigurationBinding } from '../../src/configuration/types.js';
import { authorizedExecutorBindingFingerprint, type AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { verifyExecutorRuntimeHome } from '../../src/executor/runtime-binding-verification.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(driverId: 'pi-cli' | 'codex-cli', protocol: 'openai-compatible' | 'openai-responses' | 'anthropic' = 'openai-compatible') {
  const root = await mkdtemp(join(tmpdir(), 'effective-config-'));
  roots.push(root);
  const config = {
    schemaVersion: 2,
    providers: {
      selected: { protocol, baseUrl: 'https://selected.example/v1', apiKeyRef: 'keychain:selected', enabled: true },
      unrelated: { protocol: 'openai-compatible', baseUrl: 'https://unrelated.example/v1', apiKeyRef: 'keychain:other', enabled: true },
    },
    models: {
      chosen: { providerRef: 'selected', modelId: 'chosen-model', reasoning: 'high', capabilities: ['vision'], enabled: true },
      other: { providerRef: 'selected', modelId: 'other-model', reasoning: 'disabled', capabilities: [], enabled: true },
    },
    agentClasses: {}, harnesses: {}, permissionProfiles: {}, runtimePolicy: {}, gateway: {},
  } as unknown as AnyFusionConfigurationV2;
  const authorizedBinding: AuthorizedExecutorBinding = {
    agentClassRef: 'analyst', harnessRef: 'harness', providerRef: 'selected', modelRef: 'chosen',
    permissionProfileRef: 'permission', configurationRevision: 'revision',
  };
  await new AgentRuntimeRenderer(root).render({ revisionId: 'revision', contentHash: 'audit-only', config });
  const runtimeBinding: RuntimePrivateConfigurationBinding = {
    revisionId: 'revision', bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
    environment: { OPENAI_BASE_URL: config.providers.selected.baseUrl, OPENAI_MODEL: 'chosen-model' },
    manifest: {
      driverId, protocol, baseUrl: config.providers.selected.baseUrl, modelId: 'chosen-model',
      permissionProfileRef: 'permission',
      runtimeConfiguration: executorRuntimeConfiguration(config, driverId, 'selected', 'chosen-model'),
    },
  };
  const input = { runtimeBinding, authorizedBinding, driverId, modelId: 'chosen-model',
    homePath: join(root, 'revision', driverId === 'pi-cli' ? 'pi-home' : 'codex') };
  async function edit(path: string, change: (value: any) => void) {
    const fullPath = join(input.homePath, path);
    const value = path.endsWith('.toml') ? parse(await readFile(fullPath, 'utf8')) : JSON.parse(await readFile(fullPath, 'utf8'));
    change(value);
    await writeFile(fullPath, path.endsWith('.toml') ? stringify(value) : JSON.stringify(value));
  }
  return { input, edit };
}

describe('effective Executor runtime configuration', () => {
  it.each(['openai-compatible', 'openai-responses', 'anthropic'] as const)('accepts a generated Pi configuration using %s', async protocol => {
    const { input } = await fixture('pi-cli', protocol);
    await expect(verifyExecutorRuntimeHome(input)).resolves.toBeUndefined();
  });

  it('ignores Pi whitespace, object key order, model order and unrelated entries', async () => {
    const { input, edit } = await fixture('pi-cli');
    await edit('.pi/agent/models.json', value => {
      value.providers.unrelated = { baseUrl: 'https://changed-unrelated.example' };
      const provider = value.providers.selected;
      provider.models.reverse();
      provider.models.find((model: any) => model.id === 'other-model').reasoning = true;
      value.providers.selected = Object.fromEntries(Object.entries(provider).reverse());
    });
    await edit('.pi/agent/settings.json', value => {
      const entries = Object.entries(value).reverse();
      for (const key of Object.keys(value)) delete value[key];
      Object.assign(value, Object.fromEntries(entries));
    });
    await expect(verifyExecutorRuntimeHome(input)).resolves.toBeUndefined();
  });

  it('ignores TOML formatting, comments, table order and unrelated Providers', async () => {
    const { input, edit } = await fixture('codex-cli');
    await edit('config.toml', value => {
      value.model_providers.unrelated.base_url = 'https://changed-unrelated.example';
      // Explicit authorized launch arguments override these catalog defaults.
      value.model = 'unselected-default';
      value.model_provider = 'unrelated';
      value.model_providers = Object.fromEntries(Object.entries(value.model_providers).reverse());
    });
    const path = join(input.homePath, 'config.toml');
    await writeFile(path, `# reformatted generated configuration\n\n${await readFile(path, 'utf8')}\n`);
    await expect(verifyExecutorRuntimeHome(input)).resolves.toBeUndefined();
  });

  it.each([
    ['service address', (value: any) => { value.providers.selected.baseUrl = 'https://wrong.example'; }],
    ['protocol', (value: any) => { value.providers.selected.api = 'anthropic-messages'; }],
    ['credential reference', (value: any) => { value.providers.selected.apiKey = '$OTHER_KEY'; }],
    ['model removed', (value: any) => { value.providers.selected.models.shift(); }],
    ['model substituted', (value: any) => { value.providers.selected.models[0].id = 'wrong-model'; }],
    ['duplicate model', (value: any) => { value.providers.selected.models.push(value.providers.selected.models[0]); }],
    ['model capabilities', (value: any) => { value.providers.selected.models[0].input = ['text']; }],
    ['reasoning', (value: any) => { value.providers.selected.models[0].reasoning = false; }],
    ['compatibility', (value: any) => { value.providers.selected.models[0].compat = {}; }],
  ])('rejects an effective Pi change: %s', async (_name, change) => {
    const { input, edit } = await fixture('pi-cli');
    await edit('.pi/agent/models.json', change);
    await expect(verifyExecutorRuntimeHome(input)).rejects.toThrow('Executor configuration mismatch');
  });

  it.each([
    ['service address', (value: any) => { value.model_providers.selected.base_url = 'https://wrong.example'; }],
    ['protocol', (value: any) => { value.model_providers.selected.wire_api = 'chat'; }],
    ['credential reference', (value: any) => { value.model_providers.selected.env_key = 'OTHER_KEY'; }],
    ['authentication', (value: any) => { value.model_providers.selected.requires_openai_auth = true; }],
    ['provider removed', (value: any) => { delete value.model_providers.selected; }],
    ['tool settings', (value: any) => { value.features.apps = true; }],
  ])('rejects an effective Codex change: %s', async (_name, change) => {
    const { input, edit } = await fixture('codex-cli');
    await edit('config.toml', change);
    await expect(verifyExecutorRuntimeHome(input)).rejects.toThrow('Executor configuration mismatch');
  });

  it('rejects changed Pi execution settings', async () => {
    const { input, edit } = await fixture('pi-cli');
    await edit('.pi/agent/settings.json', value => { value.enableSkillCommands = true; });
    await expect(verifyExecutorRuntimeHome(input)).rejects.toThrow('execution settings');
  });

  it.each(['revision', 'fingerprint', 'model', 'permission', 'environment'] as const)('still rejects a substituted %s binding', async kind => {
    const { input } = await fixture('pi-cli');
    if (kind === 'revision') input.runtimeBinding = { ...input.runtimeBinding, revisionId: 'other-revision' };
    if (kind === 'fingerprint') input.runtimeBinding = { ...input.runtimeBinding, bindingFingerprint: 'wrong' };
    if (kind === 'model') input.modelId = 'wrong-model';
    if (kind === 'permission') input.authorizedBinding.permissionProfileRef = 'wrong-permission';
    if (kind === 'environment') input.runtimeBinding = { ...input.runtimeBinding, environment: { OPENAI_MODEL: 'wrong-model' } };
    await expect(verifyExecutorRuntimeHome(input)).rejects.toThrow('manifest binding mismatch');
  });

  it.each(['pi-cli', 'codex-cli'] as const)('rejects missing/malformed %s configuration without echoing its contents', async driver => {
    const { input } = await fixture(driver);
    const path = join(input.homePath, driver === 'pi-cli' ? '.pi/agent/models.json' : 'config.toml');
    await writeFile(path, 'malformed secret-must-not-appear');
    const error = await verifyExecutorRuntimeHome(input).catch(error => error);
    expect(error.message).toContain('configuration could not be read');
    expect(error.message).not.toContain('secret-must-not-appear');
    await rm(path);
    await expect(verifyExecutorRuntimeHome(input)).rejects.toThrow('configuration could not be read');
  });
});
