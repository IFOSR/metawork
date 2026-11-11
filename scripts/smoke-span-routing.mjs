#!/usr/bin/env node
// Live routing decision-model smoke.
//
// The decision model is a normal Provider/Model choice (ADR-0055 D4): this
// script sends one joint `choice` request to the configured System One endpoint
// (for example the Jev server on the `way` host) and validates the answer with
// the same rules as the Server. `--integration` runs four representative
// workloads through the production Router decision adapter and SQLite replay.
//
// Target resolution order:
//   1. --base-url / --model / --api-key-env (explicit operator override)
//   2. the active MetaWork account revision (`routing.span` Provider/Model and
//      that Provider's stored credential)
//   3. --credentials <path> for the legacy internal routing credential slot
//
// Neither mode prints the key, the raw request or the raw provider payload, and
// a live third-party call stays an explicit, credentialed operator action.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { load } from 'js-yaml';

const INSTALL_ROOT = process.env.METAWORK_INSTALL_ROOT ?? process.env.METACLAW_INSTALL_ROOT ?? join(homedir(), '.metawork');
const ACCOUNT_ID = process.env.METAWORK_ACCOUNT_ID ?? 'local-default';
const SPAN_SECRET_KEY = 'routing-span';
const DEFAULT_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = {
    credentials: process.env.METAWORK_CREDENTIALS ?? '',
    installRoot: INSTALL_ROOT,
    accountId: ACCOUNT_ID,
  };
  const read = index => argv[index + 1] ?? argv[index].slice(argv[index].indexOf('=') + 1);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--integration') options.integration = true;
    else if (arg.startsWith('--credentials')) options.credentials = read(index);
    else if (arg.startsWith('--api-key-env')) options.apiKeyEnv = read(index);
    else if (arg.startsWith('--base-url')) options.baseUrl = read(index);
    else if (arg.startsWith('--model')) options.model = read(index);
    else if (arg.startsWith('--install-root')) options.installRoot = read(index);
    else if (arg.startsWith('--account')) options.accountId = read(index);
    else if (arg.startsWith('--timeout')) options.timeoutMs = Number(read(index));
  }
  return options;
}

function credentialCandidates(installRoot, explicitPath) {
  if (explicitPath) return [explicitPath];
  return [
    process.env.METAWORK_HOME,
    process.env.METACLAW_HOME,
    process.env.METAWORK_CONFIG_HOME,
    installRoot,
    join(homedir(), '.config', 'metawork'),
    join(homedir(), '.metawork'),
    join(homedir(), '.anyfusion'),
  ].filter(Boolean).map(root => join(root, 'credentials.json'));
}

function readCredentials(installRoot, explicitPath) {
  for (const candidate of credentialCandidates(installRoot, explicitPath)) {
    try {
      return { path: candidate, document: JSON.parse(readFileSync(candidate, 'utf8')) };
    } catch {
      continue;
    }
  }
  return null;
}

/** Reads the active revision's `routing.span` Provider/Model selection. */
function readActiveSpanConfiguration(installRoot, accountId) {
  const configDirectory = join(installRoot, 'accounts', accountId, 'config');
  let config;
  try {
    config = load(readFileSync(join(configDirectory, 'active', 'config.yaml'), 'utf8'));
  } catch {
    return null;
  }
  const span = config?.routing?.span;
  if (!span || typeof span !== 'object') return null;
  const model = span.modelRef ? config.models?.[span.modelRef] : undefined;
  const provider = model ? config.providers?.[model.providerRef] : undefined;
  if (!model || !provider) return { enabled: span.enabled === true, configured: false };
  return {
    enabled: span.enabled === true,
    configured: true,
    baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
    model: typeof model.modelId === 'string' ? model.modelId : undefined,
    providerRef: model.providerRef,
    apiKeyRef: typeof provider.apiKeyRef === 'string' ? provider.apiKeyRef : undefined,
  };
}

/** `file-secret:anyfusion/<group>/<name>` maps onto credentials.json `<group>.<name>`. */
function resolveSecret(document, reference) {
  if (typeof reference !== 'string') return null;
  const match = /^file-secret:anyfusion\/([a-z][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(reference);
  if (!match) return null;
  const value = document?.[match[1]]?.[match[2]];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveTarget(options) {
  const credentials = readCredentials(options.installRoot, options.credentials);
  // An explicit credentials file is a self-contained override: never mix in the
  // machine's active revision when the operator named a source.
  const active = options.credentials ? null : readActiveSpanConfiguration(options.installRoot, options.accountId);
  const envName = options.apiKeyEnv || 'METAWORK_SPAN_API_KEY';
  const fromEnv = process.env[envName]?.trim()
    ?? (options.apiKeyEnv ? undefined : process.env.OPENROUTER_API_KEY?.trim());
  const baseUrl = options.baseUrl?.trim() || active?.baseUrl;
  const model = options.model?.trim() || active?.model;
  let apiKey = fromEnv ?? null;
  let source = fromEnv ? `env:${envName}` : null;
  if (!apiKey && active?.providerRef && credentials) {
    apiKey = resolveSecret(credentials.document, active.apiKeyRef)
      ?? credentials.document?.providers?.[active.providerRef]
      ?? null;
    if (apiKey) source = `secret-store:providers/${active.providerRef}`;
  }
  if (!apiKey && credentials) {
    const value = credentials.document?.internal?.[SPAN_SECRET_KEY];
    if (typeof value === 'string' && value.trim()) {
      apiKey = value.trim();
      source = 'secret-store:internal/routing-span';
    }
  }
  return {
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, '') : null,
    model: model ?? null,
    apiKey,
    source,
    active,
  };
}

function buildRequest(model) {
  return {
    model,
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

/** Same wire shape as `defaultSpanDecisionClient` (state is a JSON string). */
async function requestDecision(target, request, signal) {
  const response = await fetch(`${target.baseUrl}/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: request.model, state: JSON.stringify(request.state), questions: request.questions }),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`routing decision provider returned HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

function describeMissingTarget(target) {
  if (!target.baseUrl || !target.model) {
    return 'No decision model configured. Set --base-url/--model, enable 系统路由 with a Provider/Model, '
      + 'or point METAWORK_INSTALL_ROOT at an installation whose active revision selects a decision model.';
  }
  return 'No decision-model credential found. Set METAWORK_SPAN_API_KEY, --api-key-env <NAME>, '
    + 'or --credentials <credentials.json>.';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget(options);
  if (!target.baseUrl || !target.model || !target.apiKey) {
    console.error(describeMissingTarget(target));
    process.exitCode = 2;
    return;
  }
  if (options.integration) {
    const root = join(import.meta.dirname, '..');
    // This machine-readable path needs successful tests' console samples too;
    // Vitest may otherwise select its minimal reporter in agent environments.
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=default',
      'tests/e2e/span-router-integration.test.ts', '-t', 'routes representative workload'], {
      cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        SPAN_LIVE_INTEGRATION: '1',
        SPAN_INTEGRATION_API_KEY: target.apiKey,
        SPAN_INTEGRATION_BASE_URL: target.baseUrl,
        SPAN_INTEGRATION_MODEL: target.model,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const samples = stripVTControlCharacters(result.stdout ?? '').split(/\r?\n/u)
      .map(line => line.trim()).filter(line => line.startsWith('{"scenario":'))
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const ok = result.status === 0 && samples.length === 4;
    console.log(JSON.stringify({ ok, credentialSource: target.source, baseUrl: target.baseUrl, model: target.model,
      samples, ...(ok ? {} : { errorCode: 'span_integration_failed' }) }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const request = buildRequest(target.model);
    const response = await requestDecision(target, request, controller.signal);
    const model = typeof response?.model === 'string' ? response.model : '';
    const answers = response?.answers && typeof response.answers === 'object' ? response.answers : {};
    const expected = Object.keys(request.questions);
    // Mirror the product validator: a missing choice or partial probability map
    // is never a successful smoke run.
    const received = Object.keys(answers);
    const answersComplete = received.length === expected.length
      && expected.every(questionId => Object.hasOwn(answers, questionId));
    const candidateIds = Object.keys(request.state.candidates);
    const answer = answers.candidates && typeof answers.candidates === 'object' ? answers.candidates : null;
    const rawProbabilities = answer?.probabilities && typeof answer.probabilities === 'object'
      ? answer.probabilities : {};
    const probabilities = {};
    let answersValid = answersComplete;
    if (!answer || answer.type !== 'choice' || !candidateIds.includes(answer.choice)
      || Object.keys(rawProbabilities).length !== candidateIds.length
      || candidateIds.some(candidateId => !Object.hasOwn(rawProbabilities, candidateId))) {
      answersValid = false;
    }
    for (const candidateId of candidateIds) {
      const value = rawProbabilities[candidateId];
      const validAnswer = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      probabilities[candidateId] = validAnswer ? Number(value.toFixed(6)) : null;
      if (!validAnswer) answersValid = false;
    }
    // The endpoint may answer with its own resolved snapshot id (Jev echoes the
    // served weights path). It must identify the model this run asked for.
    const modelValid = model.length > 0 && (model === target.model || model.includes(target.model));
    const valid = modelValid && answersValid;
    console.log(JSON.stringify({
      ok: valid,
      credentialSource: target.source,
      baseUrl: target.baseUrl,
      model: modelValid ? model : null,
      probabilities,
      usage: Object.fromEntries(['inputTokens', 'outputTokens'].flatMap(field => {
        const value = response?.usage?.[field] ?? response?.usage?.[field === 'inputTokens' ? 'input_tokens' : 'output_tokens'];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[field, value]] : [];
      })),
      durationMs: Date.now() - startedAt,
      ...(valid ? {} : { errorCode: modelValid ? 'span_invalid_response' : 'span_unexpected_model' }),
    }, null, 2));
    if (!valid) process.exitCode = 1;
  } catch (error) {
    // Only a finite code plus an optional HTTP status: the raw provider message
    // can contain request or credential material.
    const status = [error?.httpStatus, error?.status, error?.statusCode, error?.response?.status]
      .find(value => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599);
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    console.error(JSON.stringify({
      ok: false,
      credentialSource: target.source,
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
