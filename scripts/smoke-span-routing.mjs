#!/usr/bin/env node
// Real Span routing-advisor smoke test.
//
// Performs ONE live Decisions API call against `respan/span-01-lite` using the
// MetaWork-provided credential, then prints a safe summary. It never prints the
// key, the raw request, or the raw provider payload.
//
// Credential resolution order:
//   1. --api-key-env <NAME> (reads that environment variable)
//   2. OPENROUTER_API_KEY
//   3. --credentials <path> (or METAWORK_CREDENTIALS), a credentials.json that
//      contains the fixed `routing-span` SecretStore entry.
//
// Intentionally NOT wired into `npm test`: a live third-party call must stay an
// explicit, credentialed operator action.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';

const SPAN_MODEL = 'respan/span-01-lite';
const SPAN_SECRET_PROVIDER_REF = 'routing-span';
const SPAN_MODEL_VERSION = /^respan\/span-01-lite(?:-\d{8})?$/u;

function parseArgs(argv) {
  const options = { credentials: process.env.METAWORK_CREDENTIALS ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--credentials') options.credentials = argv[++index] ?? '';
    else if (arg.startsWith('--credentials=')) options.credentials = arg.slice('--credentials='.length);
    else if (arg === '--api-key-env') options.apiKeyEnv = argv[++index] ?? '';
    else if (arg.startsWith('--api-key-env=')) options.apiKeyEnv = arg.slice('--api-key-env='.length);
  }
  return options;
}

function credentialCandidates(explicitPath) {
  if (explicitPath) return [explicitPath];
  const homes = [
    process.env.METAWORK_HOME,
    process.env.METACLAW_HOME,
    process.env.METAWORK_CONFIG_HOME,
    join(homedir(), '.config', 'metawork'),
    join(homedir(), '.metawork'),
    join(homedir(), '.anyfusion'),
  ].filter(Boolean);
  return homes.map(root => join(root, 'credentials.json'));
}

function resolveApiKey(options) {
  const envName = options.apiKeyEnv || 'OPENROUTER_API_KEY';
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: `env:${envName}` };
  for (const candidate of credentialCandidates(options.credentials)) {
    let document;
    try {
      document = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch {
      continue;
    }
    const value = document?.providers?.[SPAN_SECRET_PROVIDER_REF];
    if (typeof value === 'string' && value.trim()) {
      return { apiKey: value.trim(), source: 'secret-store:routing-span' };
    }
  }
  return null;
}

function buildRequest() {
  return {
    model: SPAN_MODEL,
    state: {
      subtask: {
        title: 'Implement the parser entry point',
        goal: 'Implement the CLI parser entry point and report verification.',
        requiredCapabilities: ['workspace-engineering'],
        riskLevel: 'low',
      },
      candidates: {
        c000: { agentClass: 'codex-fast', model: 'model-fast', capabilities: ['coding', 'tools'], latencyTier: 'low' },
        c001: { agentClass: 'codex-deep', model: 'model-deep', capabilities: ['coding', 'long-context'], qualityTier: 'high' },
      },
    },
    questions: {
      c000: {
        type: 'noul',
        instructions: 'Evaluate state.candidates.c000 against state.subtask requirements.',
        criteria: {
          true: 'The named candidate is well suited to perform the described subtask.',
          false: 'The named candidate is poorly suited to perform the described subtask.',
        },
      },
      c001: {
        type: 'noul',
        instructions: 'Evaluate state.candidates.c001 against state.subtask requirements.',
        criteria: {
          true: 'The named candidate is well suited to perform the described subtask.',
          false: 'The named candidate is poorly suited to perform the described subtask.',
        },
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveApiKey(options);
  if (!resolved) {
    console.error('No Span credential found. Set OPENROUTER_API_KEY or configure the advanced-settings key.');
    process.exitCode = 2;
    return;
  }
  const client = new OpenRouter({ apiKey: resolved.apiKey, retryConfig: { strategy: 'none' } });
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await client.alpha.decisions.create(
      { decisionsRequest: buildRequest() },
      { signal: controller.signal, timeoutMs: 5_000, retries: { strategy: 'none' } },
    );
    const model = typeof response?.model === 'string' ? response.model : '';
    const answers = response?.answers && typeof response.answers === 'object' ? response.answers : {};
    const probabilities = Object.fromEntries(Object.entries(answers).map(([questionId, answer]) => [
      questionId,
      answer && typeof answer.noul === 'number' ? Number(answer.noul.toFixed(6)) : null,
    ]));
    const valid = SPAN_MODEL_VERSION.test(model)
      && Object.values(probabilities).every(value => typeof value === 'number' && value >= 0 && value <= 1);
    console.log(JSON.stringify({
      ok: valid,
      credentialSource: resolved.source,
      model,
      probabilities,
      usage: response?.usage ?? null,
      durationMs: Date.now() - startedAt,
    }, null, 2));
    if (!valid) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      ok: false,
      credentialSource: resolved.source,
      error: message.slice(0, 200),
      durationMs: Date.now() - startedAt,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

await main();
