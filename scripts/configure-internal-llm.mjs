import { mkdir, readFile, writeFile, rename, chmod, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

// Explicit one-time credential copy; never run automatically on Server startup.
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const root = resolve(option('--install-root') ?? process.env.METAWORK_INSTALL_ROOT ?? join(homedir(), '.metawork'));
const modelRef = option('--model-ref');
if (!modelRef) throw new Error('Usage: node scripts/configure-internal-llm.mjs --model-ref <configured-model-ref> [--install-root <path>]');
const config = yaml.load(await readFile(join(root, 'accounts/local-default/config/active/config.yaml'), 'utf8'));
const model = config.models?.[modelRef];
const provider = model && config.providers?.[model.providerRef];
if (!model || !provider || provider.protocol !== 'openai-compatible') throw new Error('Select an existing OpenAI-compatible model');
const credentialMatch = /^(?:file-secret|keychain):anyfusion\/(?:providers\/)?([a-z][a-z0-9-]{0,63})$/u.exec(provider.apiKeyRef);
const credentials = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
const apiKey = credentialMatch && credentials.providers?.[credentialMatch[1]];
if (!apiKey) throw new Error('Selected Provider credential is unavailable');
const directory = join(root, 'internal');
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = join(directory, 'llm.json');
const secretsPath = join(directory, 'llm-credentials.json');
for (const path of [configPath, secretsPath]) {
  try { await access(path); throw new Error('Internal LLM is already configured; maintain its independent files directly'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const internal = {
  provider: provider.displayName ?? model.providerRef,
  displayName: model.modelId,
  baseUrl: provider.baseUrl,
  modelId: model.modelId,
  apiKeyRef: 'file-secret:anyfusion/internal/llm',
  enabled: true, timeoutMs: 60_000, maxTokens: 4_096,
  ...(/deepseek/iu.test(model.modelId) ? { thinking: 'disabled' } : {}),
};
async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
await atomicWrite(secretsPath, { version: 1, providers: {}, internal: { llm: apiKey } });
await atomicWrite(configPath, internal);
console.log(JSON.stringify({ configPath, secretsPath, modelId: model.modelId, credentialCopied: true }));
