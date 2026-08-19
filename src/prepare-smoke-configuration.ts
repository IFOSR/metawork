import { resolve } from 'node:path';
import { prepareSmokeConfiguration } from './configuration/smoke-configuration.js';

async function main(): Promise<void> {
  const installRoot = process.argv[2]?.trim();
  const configHome = process.argv[3]?.trim();
  const executorCommand = process.env.METACLAW_SMOKE_EXECUTOR ?? 'codex';
  const executorTimeoutSeconds = Number(process.env.METACLAW_SMOKE_EXECUTOR_TIMEOUT ?? '900');
  const executorMaxDurationSeconds = Number(process.env.METACLAW_SMOKE_EXECUTOR_MAX_DURATION ?? '3600');
  if (!installRoot || !configHome) {
    throw new Error(
      'usage: prepare-smoke-configuration <install-root> <config-home>',
    );
  }
  if (!Number.isFinite(executorTimeoutSeconds) || !Number.isFinite(executorMaxDurationSeconds)) {
    throw new Error('smoke executor timeout values must be finite numbers');
  }
  await prepareSmokeConfiguration({
    installRoot: resolve(installRoot),
    configHome: resolve(configHome),
    executorCommand,
    executorTimeoutSeconds,
    executorMaxDurationSeconds,
  });
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
