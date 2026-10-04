import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The live smoke script is an operator action, but its verification contract
 * must not drift from the product validator: an empty choice/probability set is not a
 * success, and no raw SDK/provider text may reach the terminal.
 */

const projectRoot = resolve(__dirname, '../..');
const scriptPath = join(projectRoot, 'scripts/smoke-span-routing.mjs');

function runSmoke(
  stubSource: string,
  options: { args?: string[]; env?: Record<string, string | undefined>; preloadChild?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'span-smoke-'));
  try {
    const stubPath = join(root, 'stub-fetch.mjs');
    writeFileSync(stubPath, stubSource, 'utf8');
    const result = spawnSync(
      process.execPath,
      ['--import', stubPath, scriptPath, ...(options.args ?? [])],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, OPENROUTER_API_KEY: 'smoke-fake-credential', ...options.env,
          ...(options.preloadChild ? { NODE_OPTIONS: `--import=${stubPath}` } : {}) },
      },
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withCredentialsFile(
  credentials: Record<string, unknown>,
  run: (path: string) => { status: number | null; stdout: string; stderr: string },
): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'span-smoke-credentials-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    writeFileSync(credentialsPath, JSON.stringify(credentials), 'utf8');
    return run(credentialsPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function responseStub(body: string, status = 200): string {
  return `globalThis.fetch = async () => new Response(${JSON.stringify(body)}, `
    + `{ status: ${status}, headers: { 'Content-Type': 'application/json' } });\n`;
}

describe('Span routing smoke script', () => {
  it.each([false, true])('sends string state through the SDK (integration=%s)', integration => {
    const result = runSmoke(`globalThis.fetch = async request => {
      if (new URL(request.url).pathname !== '/api/v1/systemone') return new Response(JSON.stringify({
        error: { message: 'wrong System One endpoint', code: 404 },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const body = await request.json();
      if (typeof body.state !== 'string') return new Response(JSON.stringify({
        error: { message: 'state must be a string', code: 400 },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const state = JSON.parse(body.state);
      if (!state.subtask?.goal) throw new Error('serialized task state is missing');
      const candidateIds = Object.keys(state.candidates ?? {});
      const probabilities = Object.fromEntries(candidateIds.map((id, index) => [
        id,
        index === 0 ? 0.75 : 0.25 / Math.max(1, candidateIds.length - 1),
      ]));
      return new Response(JSON.stringify({ model: 'inception/mercury-decide:free',
        answers: { candidates: { type: 'choice', choice: candidateIds[0], probabilities } },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };`, { args: integration ? ['--integration'] : [], preloadChild: integration });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    if (integration) {
      expect(output.samples).toHaveLength(4);
      expect(output.samples.every((sample: any) => sample.replayCalls === 0)).toBe(true);
    }
    expect(result.stdout).not.toContain('smoke-fake-credential');
  });

  it('redacts unexpected model text and unknown usage fields', () => {
    const result = runSmoke(responseStub(JSON.stringify({ model: 'RAW_SECRET_MODEL',
      answers: { candidates: { type: 'choice', choice: 'c000', probabilities: { c000: 0.5, c001: 0.5 } } },
      usage: { input_tokens: 1, output_tokens: 0, raw: 'RAW_SECRET_USAGE' },
    })));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('RAW_SECRET');
    expect(JSON.parse(result.stdout)).toMatchObject({ errorCode: 'span_unexpected_model', model: null });
  });

  it('fails when the provider returns no answers', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      model: 'inception/mercury-decide-20260930',
      answers: {},
      usage: { input_tokens: 0, output_tokens: 0 },
    })));

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      errorCode: 'span_invalid_response',
    });
  });

  it('fails on a partial answer set instead of accepting known ids only', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      model: 'inception/mercury-decide-20260930',
      answers: { candidates: { type: 'choice', choice: 'c000', probabilities: { c000: 0.5 } } },
      usage: { input_tokens: 1, output_tokens: 0 },
    })));

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it('passes only for a complete, finite, in-range choice probability set', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      model: 'inception/mercury-decide-20260930',
      answers: { candidates: { type: 'choice', choice: 'c001', probabilities: { c000: 0.3, c001: 0.7 } } },
      usage: { input_tokens: 476, output_tokens: 70 },
    })));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      model: 'inception/mercury-decide-20260930',
      probabilities: { c000: 0.3, c001: 0.7 },
    });
  });

  it('never prints the raw provider error body', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      error: { message: 'SMOKE_RAW_SECRET_MARKER', code: 401 },
    }), 401));

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('SMOKE_RAW_SECRET_MARKER');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      errorCode: 'span_http_error',
      httpStatus: 401,
    });
  });

  it('reads the credential from the internal namespace of credentials.json', () => {
    const result = withCredentialsFile(
      { version: 1, providers: {}, internal: { 'routing-span': 'internal-span-key' } },
      path => runSmoke(responseStub(JSON.stringify({
        model: 'inception/mercury-decide-20260930',
        answers: { candidates: { type: 'choice', choice: 'c001', probabilities: { c000: 0.3, c001: 0.7 } } },
        usage: { input_tokens: 476, output_tokens: 70 },
      })), { args: ['--credentials', path], env: { OPENROUTER_API_KEY: undefined } }),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      credentialSource: 'secret-store:internal/routing-span',
    });
  });

  it('never falls back to a Provider credential named routing-span', () => {
    const result = withCredentialsFile(
      { version: 1, providers: { 'routing-span': 'provider-only-key' } },
      path => runSmoke('', { args: ['--credentials', path], env: { OPENROUTER_API_KEY: undefined } }),
    );

    // The Provider namespace is not a Span credential source, so the script
    // must refuse to run instead of sending that key to OpenRouter.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No Span credential');
    expect(result.stdout).not.toContain('provider-only-key');
  });
});
