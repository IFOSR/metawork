// Defines the native configuration wizard order and its non-interactive input
// contract. A config file may drive the same steps without prompting; missing
// Executor commands create disabled profiles rather than failing the install.
import { createInterface } from 'node:readline/promises';
import { PUBLIC_PROVIDER_PRESETS } from '../configuration/public-provider-catalog.js';

export const CONFIGURATION_WIZARD_ORDER = [
  'region',
  'provider_secret',
  'planner_harness',
  'planner_model_policy',
  'executor_command_detection',
  'executor_agent_classes',
  'model_permission_skill_bindings',
  'validation_summary',
  'activation',
] as const;

export type ConfigurationWizardStep = typeof CONFIGURATION_WIZARD_ORDER[number];

export interface ConfigurationWizardInput {
  region?: string;
  providerUrl?: string;
  providerKeyRef?: string;
  plannerHarnessRef?: string;
  plannerModelRef?: string;
  executorCommands?: Record<string, string>;
}

export interface WizardValidationResult {
  ok: boolean;
  issues: string[];
}

export function validateWizardInput(input: ConfigurationWizardInput): WizardValidationResult {
  const issues: string[] = [];
  if (!input.region?.trim()) issues.push('region is required');
  if (!input.providerUrl?.trim()) issues.push('providerUrl is required');
  if (!input.providerKeyRef?.trim()) issues.push('providerKeyRef is required');
  if (!input.plannerHarnessRef?.trim()) issues.push('plannerHarnessRef is required');
  if (!input.plannerModelRef?.trim()) issues.push('plannerModelRef is required');
  return { ok: issues.length === 0, issues };
}

export function nextWizardStep(current: ConfigurationWizardStep | null): ConfigurationWizardStep {
  if (!current) return CONFIGURATION_WIZARD_ORDER[0];
  const index = CONFIGURATION_WIZARD_ORDER.indexOf(current);
  return CONFIGURATION_WIZARD_ORDER[Math.min(index + 1, CONFIGURATION_WIZARD_ORDER.length - 1)]!;
}

export interface WizardProviderPreset {
  readonly providerRef: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly defaultModelId: string;
  readonly modelIds: readonly string[];
}

export interface WizardProviderInput {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export interface WizardProviderDefaults {
  readonly baseUrl?: string;
  readonly modelId?: string;
}

export interface ProviderPrompt {
  select(options: readonly string[], defaultIndex: number): Promise<number>;
  ask(label: string, defaultValue?: string): Promise<string>;
  confirm(label: string): Promise<boolean>;
  askSecret(label: string): Promise<string>;
  notify(line: string): void;
}

export type ProviderProbeOutcome =
  | { readonly status: 'verified' }
  | { readonly status: 'unverifiable'; readonly detail?: string }
  | { readonly status: 'rejected'; readonly detail?: string };

export type ProviderProbe = (baseUrl: string, apiKey: string) => Promise<ProviderProbeOutcome>;

const CUSTOM_PROVIDER_LABEL = 'Custom OpenAI-compatible provider';

export function wizardProviderPresets(): readonly WizardProviderPreset[] {
  return PUBLIC_PROVIDER_PRESETS.map(preset => ({
    providerRef: preset.providerRef,
    displayName: preset.displayName,
    baseUrl: preset.baseUrl,
    defaultModelId: preset.modelIds[0] ?? '',
    modelIds: preset.modelIds,
  }));
}

function presetByBaseUrl(baseUrl: string): WizardProviderPreset | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  return wizardProviderPresets().find(preset => preset.baseUrl === normalized);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function isValidProviderBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Collects the provider binding for a fresh installation: preset or custom
 * OpenAI-compatible endpoint, model, and API key. Pure orchestration over an
 * injected prompt so tests stay deterministic; `probe` (optional) performs a
 * live key check and may be omitted in offline contexts.
 */
export async function collectProviderInput(
  prompt: ProviderPrompt,
  options: {
    defaults?: WizardProviderDefaults;
    probe?: ProviderProbe;
  } = {},
): Promise<WizardProviderInput> {
  const defaults = options.defaults ?? {};
  const presets = wizardProviderPresets();

  let baseUrl: string;
  let modelDefault: string;
  if (defaults.baseUrl?.trim()) {
    baseUrl = normalizeBaseUrl(defaults.baseUrl);
    const preset = presetByBaseUrl(baseUrl);
    modelDefault = defaults.modelId?.trim()
      ?? (preset ? preset.defaultModelId : '');
    if (preset) {
      prompt.notify(`Provider: ${preset.displayName}`);
    }
  } else {
    const labels = [
      ...presets.map(preset => `${preset.displayName} (${preset.baseUrl})`),
      CUSTOM_PROVIDER_LABEL,
    ];
    const defaultIndex = 0;
    const choice = await prompt.select(labels, defaultIndex);
    if (choice >= presets.length) {
      baseUrl = normalizeBaseUrl(await prompt.ask('API base URL (OpenAI-compatible)'));
      while (!isValidProviderBaseUrl(baseUrl)) {
        prompt.notify('Base URL must start with http:// or https://');
        baseUrl = normalizeBaseUrl(await prompt.ask('API base URL (OpenAI-compatible)'));
      }
      modelDefault = defaults.modelId?.trim() ?? '';
    } else {
      const preset = presets[choice]!;
      baseUrl = preset.baseUrl;
      modelDefault = defaults.modelId?.trim() ?? preset.defaultModelId;
      prompt.notify(`Provider: ${preset.displayName}`);
    }
  }

  let modelId = (await prompt.ask('Model ID', modelDefault)).trim();
  while (!modelId) {
    prompt.notify('Model ID is required');
    modelId = (await prompt.ask('Model ID')).trim();
  }

  let apiKey = '';
  for (;;) {
    apiKey = (await prompt.askSecret('API key (input hidden)')).trim();
    if (!apiKey) {
      prompt.notify('API key is required');
      continue;
    }
    if (!options.probe) break;
    const outcome = await options.probe(baseUrl, apiKey);
    if (outcome.status === 'verified') {
      prompt.notify('API key verified.');
      break;
    }
    if (outcome.status === 'unverifiable') {
      prompt.notify(
        outcome.detail
          ? `Could not verify the key (${outcome.detail}); continuing.`
          : 'Could not verify the key; continuing.',
      );
      break;
    }
    const retry = await prompt.confirm(
      `API key rejected${outcome.detail ? `: ${outcome.detail}` : ''}. Enter another key?`,
    );
    if (!retry) break;
  }

  return { baseUrl, modelId, apiKey };
}

export function createTerminalProviderPrompt(input: {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}): ProviderPrompt & { close(): void } {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    close() {
      readline.close();
    },
    async select(options, defaultIndex) {
      stdout.write('Select a model provider:\n');
      options.forEach((option, index) => {
        stdout.write(`  ${index + 1}) ${option}${index === defaultIndex ? ' [default]' : ''}\n`);
      });
      for (;;) {
        const answer = (await readline.question(`Choice [${defaultIndex + 1}]: `)).trim();
        if (!answer) return defaultIndex;
        const parsed = Number.parseInt(answer, 10);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= options.length) {
          return parsed - 1;
        }
        stdout.write(`Enter a number between 1 and ${options.length}.\n`);
      }
    },
    async ask(label, defaultValue) {
      if (defaultValue) {
        return (await readline.question(`${label} [${defaultValue}]: `)).trim() || defaultValue;
      }
      return (await readline.question(`${label}: `)).trim();
    },
    async confirm(label) {
      const answer = (await readline.question(`${label} [Y/n]: `)).trim().toLowerCase();
      return !answer.startsWith('n');
    },
    async askSecret(label) {
      if (stdin.isTTY) {
        // Detach the readline interface while reading raw keystrokes so the
        // key characters are neither echoed nor buffered into the next
        // question's line input.
        readline.pause();
        try {
          return await readMaskedLine(stdin, stdout, label);
        } finally {
          readline.resume();
        }
      }
      stdout.write('(terminal does not support hidden input)\n');
      return (await readline.question(`${label}: `)).trim();
    },
    notify(line) {
      stdout.write(`${line}\n`);
    },
  };
}

async function readMaskedLine(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  label: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    stdout.write(`${label}: `);
    const characters: string[] = [];
    let settled = false;

    const restore = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      restore();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(characters.join(''));
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          finish(null);
          return;
        }
        if (character === '\u0003') {
          finish(new Error('input cancelled'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (characters.length > 0) {
            characters.pop();
            stdout.write('\b \b');
          }
          continue;
        }
        if (character === '\u0015') {
          while (characters.length > 0) {
            characters.pop();
            stdout.write('\b \b');
          }
          continue;
        }
        if (character < ' ') continue;
        characters.push(character);
        stdout.write('*');
      }
    };
    const onEnd = () => finish(null);
    const onError = (error: Error) => finish(error);

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.setRawMode(true);
    stdin.resume();
  });
}
