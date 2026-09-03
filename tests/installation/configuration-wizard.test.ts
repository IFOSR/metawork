import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CONFIGURATION_WIZARD_ORDER,
  collectProviderInput,
  createTerminalProviderPrompt,
  isValidProviderBaseUrl,
  nextWizardStep,
  validateWizardInput,
  wizardProviderPresets,
  type ProviderPrompt,
} from '../../src/installation/configuration-wizard.js';

class FakePrompt implements ProviderPrompt {
  readonly notifications: string[] = [];
  readonly asked: Array<{ label: string; defaultValue?: string }> = [];
  readonly confirmed: boolean[] = [];
  readonly confirmLabels: string[] = [];
  secretRequests = 0;

  constructor(
    private readonly selections: number[],
    private readonly answers: string[],
    private readonly secrets: string[],
    private readonly confirmations: boolean[] = [],
  ) {}

  async select(_options: readonly string[], _defaultIndex: number): Promise<number> {
    const next = this.selections.shift();
    if (next === undefined) throw new Error('unexpected select call');
    return next;
  }

  async ask(label: string, defaultValue?: string): Promise<string> {
    this.asked.push({ label, defaultValue });
    // An exhausted answer queue models the user pressing Enter to accept
    // the offered default, matching the terminal prompt behavior.
    const next = this.answers.shift();
    return next === undefined ? (defaultValue ?? '') : next;
  }

  async confirm(label: string): Promise<boolean> {
    this.confirmLabels.push(label);
    const next = this.confirmations.shift();
    if (next === undefined) throw new Error('unexpected confirm call');
    return next;
  }

  async askSecret(_label: string): Promise<string> {
    this.secretRequests += 1;
    const next = this.secrets.shift();
    if (next === undefined) throw new Error('unexpected secret call');
    return next;
  }

  notify(line: string): void {
    this.notifications.push(line);
  }
}

describe('configuration-wizard', () => {
  it('validates complete input', () => {
    expect(validateWizardInput({
      region: 'international',
      providerUrl: 'https://api.example.com/v1',
      providerKeyRef: 'keychain:anyfusion/provider',
      plannerHarnessRef: 'anyfusion-planner',
      plannerModelRef: 'test-model',
    })).toEqual({ ok: true, issues: [] });
  });

  it('reports every missing required field', () => {
    const result = validateWizardInput({ region: 'international' });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      'providerUrl is required',
      'providerKeyRef is required',
      'plannerHarnessRef is required',
      'plannerModelRef is required',
    ]);
  });

  it('advances through the wizard order and stays on the last step', () => {
    expect(CONFIGURATION_WIZARD_ORDER[0]).toBe('region');
    expect(CONFIGURATION_WIZARD_ORDER.at(-1)).toBe('activation');
    expect(nextWizardStep(null)).toBe('region');
    expect(nextWizardStep('region')).toBe('provider_secret');
    expect(nextWizardStep('activation')).toBe('activation');
  });

  it('derives wizard presets from the public provider catalog', () => {
    const presets = wizardProviderPresets();
    expect(presets.map(preset => preset.providerRef)).toEqual(['code-cli', 'kimi', 'deepseek']);
    const deepseek = presets.find(preset => preset.providerRef === 'deepseek');
    expect(deepseek?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(deepseek?.defaultModelId).toBe('deepseek-chat');
    expect(deepseek?.modelIds).toContain('deepseek-reasoner');
  });

  it('validates provider base URLs', () => {
    expect(isValidProviderBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(isValidProviderBaseUrl('http://localhost:8000/v1')).toBe(true);
    expect(isValidProviderBaseUrl('ftp://api.example.com')).toBe(false);
    expect(isValidProviderBaseUrl('api.example.com')).toBe(false);
    expect(isValidProviderBaseUrl('  ')).toBe(false);
  });

  it('collects a preset provider with defaults and a verified key', async () => {
    const prompt = new FakePrompt([2], [], ['sk-wizard']);
    const result = await collectProviderInput(prompt, {
      probe: async () => ({ status: 'verified' }),
    });
    expect(result).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
      apiKey: 'sk-wizard',
    });
    expect(prompt.asked.find(entry => entry.label === 'Model ID')?.defaultValue)
      .toBe('deepseek-chat');
    expect(prompt.notifications).toContain('Provider: DeepSeek');
    expect(prompt.notifications).toContain('API key verified.');
  });

  it('rejects invalid custom base URLs until a valid one is provided', async () => {
    const prompt = new FakePrompt(
      [3],
      ['not-a-url', 'https://gateway.example/v1', 'my-model'],
      ['sk-custom'],
    );
    const result = await collectProviderInput(prompt, {
      probe: async () => ({ status: 'verified' }),
    });
    expect(result).toEqual({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'my-model',
      apiKey: 'sk-custom',
    });
    expect(prompt.notifications).toContain('Base URL must start with http:// or https://');
  });

  it('prefills from defaults without offering preset selection', async () => {
    const prompt = new FakePrompt([], [], ['sk-prefilled']);
    const result = await collectProviderInput(prompt, {
      defaults: {
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-reasoner',
      },
      probe: async () => ({ status: 'verified' }),
    });
    expect(result).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-reasoner',
      apiKey: 'sk-prefilled',
    });
    expect(prompt.asked.filter(entry => entry.label === 'Model ID')[0]?.defaultValue)
      .toBe('deepseek-reasoner');
  });

  it('requires a model ID for custom defaults', async () => {
    const prompt = new FakePrompt([], ['', 'm1'], ['sk-x']);
    const result = await collectProviderInput(prompt, {
      defaults: { baseUrl: 'https://gateway.example/v1' },
      probe: async () => ({ status: 'verified' }),
    });
    expect(result.modelId).toBe('m1');
    expect(prompt.notifications).toContain('Model ID is required');
  });

  it('re-prompts for an empty API key without probing', async () => {
    const prompt = new FakePrompt([], [], ['', 'sk-real']);
    let probes = 0;
    const result = await collectProviderInput(prompt, {
      defaults: { baseUrl: 'https://api.deepseek.com/v1' },
      probe: async () => {
        probes += 1;
        return { status: 'verified' };
      },
    });
    expect(result.apiKey).toBe('sk-real');
    expect(probes).toBe(1);
    expect(prompt.notifications).toContain('API key is required');
  });

  it('keeps a rejected key when the user declines to retry', async () => {
    const prompt = new FakePrompt([], [], ['sk-bad'], [false]);
    const result = await collectProviderInput(prompt, {
      defaults: { baseUrl: 'https://api.deepseek.com/v1' },
      probe: async () => ({ status: 'rejected', detail: 'HTTP 401 from GET /models' }),
    });
    expect(result.apiKey).toBe('sk-bad');
    expect(prompt.confirmLabels.join('\n')).toContain('API key rejected: HTTP 401 from GET /models');
    expect(prompt.secretRequests).toBe(1);
  });

  it('accepts the next key after a rejected probe and retry', async () => {
    const prompt = new FakePrompt([], [], ['sk-bad', 'sk-good'], [true]);
    const probedKeys: string[] = [];
    const result = await collectProviderInput(prompt, {
      defaults: { baseUrl: 'https://api.deepseek.com/v1' },
      probe: async (_baseUrl, apiKey) => {
        probedKeys.push(apiKey);
        return probedKeys.length === 1
          ? { status: 'rejected', detail: 'HTTP 401 from GET /models' }
          : { status: 'verified' };
      },
    });
    expect(result.apiKey).toBe('sk-good');
    expect(probedKeys).toEqual(['sk-bad', 'sk-good']);
  });

  it('continues when the probe cannot verify the endpoint', async () => {
    const prompt = new FakePrompt([], [], ['sk-net']);
    const result = await collectProviderInput(prompt, {
      defaults: { baseUrl: 'https://api.deepseek.com/v1' },
      probe: async () => ({ status: 'unverifiable', detail: 'fetch failed' }),
    });
    expect(result.apiKey).toBe('sk-net');
    expect(prompt.notifications.join('\n')).toContain('Could not verify the key (fetch failed)');
  });

  it('masks hidden input and handles backspace and cancellation', async () => {
    class FakeTty extends EventEmitter {
      isTTY = true;
      rawModes: boolean[] = [];
      setRawMode(mode: boolean): void {
        this.rawModes.push(mode);
      }
      pause(): void {}
      resume(): void {}
    }
    const stdin = new FakeTty();
    const written: string[] = [];
    const stdout = {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    };
    const prompt = createTerminalProviderPrompt({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    const first = prompt.askSecret('API key');
    await new Promise(resolve => setImmediate(resolve));
    stdin.emit('data', Buffer.from('sk-9'));
    stdin.emit('data', Buffer.from('\u007f'));
    stdin.emit('data', Buffer.from('1'));
    stdin.emit('data', Buffer.from('\r'));
    await expect(first).resolves.toBe('sk-1');

    const second = prompt.askSecret('API key');
    await new Promise(resolve => setImmediate(resolve));
    stdin.emit('data', Buffer.from('\u0003'));
    await expect(second).rejects.toThrow('input cancelled');

    expect(written.join('')).toContain('***');
    expect(stdin.rawModes).toEqual([true, false, true, false]);
  });
});
