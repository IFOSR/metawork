import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * The Desktop shell and the Runtime are installed at different moments: the
 * shell that launches the candidate Runtime is still the *old* shell, and it used
 * to pass `METACLAW_EXECUTOR_BACKEND=in_place`. Once `in_place` was retired from
 * the Runtime's accepted values, every Desktop upgrade failed with
 * `runtime-not-ready`, rolled back, and looped on the recovery screen.
 *
 * These tests pin both halves of the fix: the Runtime keeps accepting the retired
 * name, and the shell no longer sends it.
 */
import { createDefaultAttemptExecutionBackend } from '../../src/account/account-task-services.js';

function backendName(value: string | undefined): string {
  if (value === undefined) vi.stubEnv('METACLAW_EXECUTOR_BACKEND', '');
  else vi.stubEnv('METACLAW_EXECUTOR_BACKEND', value);
  return createDefaultAttemptExecutionBackend('/tmp/state').constructor.name;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('attempt execution backend selection', () => {
  it.each([
    ['native', 'native'],
    ['in_place', 'native'],
    [undefined, 'native'],
    ['docker', 'docker'],
    ['container', 'docker'],
  ])('maps %s to the %s backend', (value, expected) => {
    expect(backendName(value)).toBe(expected === 'native'
      ? 'NativeAttemptExecutionBackend'
      : 'DockerCliAttemptExecutionBackend');
  });

  it('still rejects values that never named a backend', () => {
    expect(() => backendName('remote-cluster')).toThrow(/Unsupported METACLAW_EXECUTOR_BACKEND/);
  });
});
