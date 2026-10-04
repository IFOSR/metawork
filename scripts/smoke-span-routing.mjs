#!/usr/bin/env node
// Real Span routing-advisor smoke test using OpenRouter System One.
//
// By default performs ONE live System One API call against
// `inception/mercury-decide:free`.
// --integration runs four sample workloads through the production advisor,
// ControlKernel and SQLite replay (three calls; single-candidate makes none).
// Both modes use the MetaWork credential and print finite safe summaries.
// Neither mode prints the key, the raw request, or the raw provider payload.
//
// Credential resolution order:
//   1. --api-key-env <NAME> (reads that environment variable)
//   2. OPENROUTER_API_KEY
//   3. --credentials <path> (or METAWORK_CREDENTIALS), a credentials.json that
//      contains the fixed `file-secret:anyfusion/internal/routing-span` entry.
//
// The Provider namespace is deliberately NOT consulted: a Provider that happens
// to be named `routing-span` must never supply the advisor credential.
//
// Intentionally NOT wired into `npm test`: a live third-party call must stay an
// explicit, credentialed operator action.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';

const SPAN_MODEL = 'inception/mercury-decide:free';
const SPAN_SECRET_KEY = 'routing-span';
const SPAN_MODEL_VERSION = /^inception\/mercury-decide(?::free|-\d{8})?$/u;
function parseArgs(argv) {
  const options = { credentials: process.env.METAWORK_CREDENTIALS ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--integration') options.integration = true;
    else if (arg === '--credentials') options.credentials = argv[++index] ?? '';
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
    const value = document?.internal?.[SPAN_SECRET_KEY];
    if (typeof value === 'string' && value.trim()) {
      return { apiKey: value.trim(), source: 'secret-store:internal/routing-span' };
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
      candidates: {
        type: 'choice',
        instructions: 'Choose the single best candidate from all options and return probabilities for every option.',
        criteria: {
          c000: 'Candidate c000 is a valid option described in state.candidates.c000.',
          c001: 'Candidate c001 is a valid option described in state.candidates.c001.',
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
  if (options.integration) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'tests/e2e/span-routing.test.ts', '-t', 'compares representative workload'], {
      cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SPAN_LIVE_INTEGRATION: '1', SPAN_INTEGRATION_API_KEY: resolved.apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const samples = (result.stdout ?? '').split('\n').filter(line => line.startsWith('{"scenario":'))
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const ok = result.status === 0 && samples.length === 4;
    console.log(JSON.stringify({ ok, credentialSource: resolved.source, samples,
      ...(ok ? {} : { errorCode: 'span_integration_failed' }) }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  const client = new OpenRouter({ apiKey: resolved.apiKey, retryConfig: { strategy: 'none' } });
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const request = buildRequest();
    const response = await client.systemOne.create(
      { decisionsRequest: { ...request, state: JSON.stringify(request.state) } },
      { signal: controller.signal, timeoutMs: 5_000, retries: { strategy: 'none' } },
    );
    const model = typeof response?.model === 'string' ? response.model : '';
    const answers = response?.answers && typeof response.answers === 'object' ? response.answers : {};
    const expected = Object.keys(buildRequest().questions);
    // Mirror the product validator: a missing choice or partial probability
    // map is never a successful smoke run.
    const received = Object.keys(answers);
    const answersComplete = received.length === expected.length
      && expected.every(questionId => Object.hasOwn(answers, questionId));
    const candidateIds = Object.keys(buildRequest().state.candidates);
    const answer = answers.candidates && typeof answers.candidates === 'object'
      ? answers.candidates
      : null;
    const rawProbabilities = answer?.probabilities && typeof answer.probabilities === 'object'
      ? answer.probabilities
      : {};
    const probabilities = {};
    let answersValid = answersComplete;
    if (!answer || answer.type !== 'choice' || !candidateIds.includes(answer.choice)
      || Object.keys(rawProbabilities).length !== candidateIds.length
      || candidateIds.some(candidateId => !Object.hasOwn(rawProbabilities, candidateId))) {
      answersValid = false;
    }
    for (const candidateId of candidateIds) {
      const value = rawProbabilities[candidateId];
      const validAnswer = typeof value === 'number' && Number.isFinite(value)
        && value >= 0 && value <= 1;
      probabilities[candidateId] = validAnswer ? Number(value.toFixed(6)) : null;
      if (!validAnswer) answersValid = false;
    }
    const valid = SPAN_MODEL_VERSION.test(model) && answersValid;
    console.log(JSON.stringify({
      ok: valid,
      credentialSource: resolved.source,
      model: SPAN_MODEL_VERSION.test(model) ? model : null,
      probabilities,
      usage: Object.fromEntries(['cost', 'inputTokens', 'outputTokens'].flatMap(field => {
        const value = response?.usage?.[field];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[field, value]] : [];
      })),
      durationMs: Date.now() - startedAt,
      ...(valid ? {} : { errorCode: SPAN_MODEL_VERSION.test(model) ? 'span_invalid_response' : 'span_unexpected_model' }),
    }, null, 2));
    if (!valid) process.exitCode = 1;
  } catch (error) {
    // Only a finite code plus an optional HTTP status: the raw SDK/provider
    // message can contain request or credential material.
    const status = [error?.status, error?.statusCode, error?.response?.status]
      .find(value => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599);
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    console.error(JSON.stringify({
      ok: false,
      credentialSource: resolved.source,
      errorCode: timedOut ? 'span_timeout' : 'span_http_error',
      ...(typeof status === 'number' ? { httpStatus: status } : {}),
      durationMs: Date.now() - startedAt,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

await main();
