import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The live smoke script is an operator action, but its verification contract
 * must not drift from the product validator: an empty answer set is not a
 * success, and no raw SDK/provider text may reach the terminal.
 */

const projectRoot = resolve(__dirname, '../..');
const scriptPath = join(projectRoot, 'scripts/smoke-span-routing.mjs');

function runSmoke(stubSource: string): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'span-smoke-'));
  try {
    const stubPath = join(root, 'stub-fetch.mjs');
    writeFileSync(stubPath, stubSource, 'utf8');
    const result = spawnSync(
      process.execPath,
      ['--import', stubPath, scriptPath],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, OPENROUTER_API_KEY: 'smoke-fake-credential' },
      },
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function responseStub(body: string, status = 200): string {
  return `globalThis.fetch = async () => new Response(${JSON.stringify(body)}, `
    + `{ status: ${status}, headers: { 'Content-Type': 'application/json' } });\n`;
}

describe('Span routing smoke script', () => {
  it('fails when the provider returns no answers', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      model: 'respan/span-01-lite-20260925',
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
      model: 'respan/span-01-lite-20260925',
      answers: { c000: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    })));

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it('passes only for a complete, finite, in-range noul answer set', () => {
    const result = runSmoke(responseStub(JSON.stringify({
      model: 'respan/span-01-lite-20260925',
      answers: {
        c000: { type: 'noul', noul: 0.61 },
        c001: { type: 'noul', noul: 0.7 },
      },
      usage: { input_tokens: 476, output_tokens: 70 },
    })));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      model: 'respan/span-01-lite-20260925',
      probabilities: { c000: 0.61, c001: 0.7 },
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
});
