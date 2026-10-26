import { spawnSync } from 'node:child_process';

const PROVIDER = 'metawork-executor-package-check';
const MODEL = 'metawork-executor-package-check';

/** Verify the packaged Executor is a normal Pi Agent, not the restricted Planner CLI. */
export function verifyExecutorPi(command, options = {}) {
  const result = spawnSync(command, [
    '--mode', 'json', '--no-session', '--tools', '',
    '--provider', PROVIDER, '--model', MODEL, '--help',
  ], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 0 || !/\bUsage:\s+pi\b/u.test(output)
    || !/--provider\s/u.test(output) || !/--model\s/u.test(output)) {
    throw new Error('Executor Pi must accept authorized --provider/--model arguments and print normal Pi help');
  }
  return output;
}
