import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const installRoot = mkdtempSync(join(tmpdir(), 'anyfusion-gateway-smoke-'));
const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const acceptanceFiles = [
  'tests/architecture/no-direct-client-session-paths.test.ts',
  'tests/architecture/unified-server-composition.test.ts',
  'tests/integration/unified-client-runtime.integration.test.ts',
  'tests/security/gateway-account-isolation.test.ts',
  'tests/gateway/server-lifecycle.test.ts',
  'tests/gateway/scripted-gateway-session.test.ts',
  'tests/management/web-gateway-session-runtime.test.ts',
];

try {
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', ...acceptanceFiles],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANYFUSION_INSTALL_ROOT: installRoot,
        METACLAW_INSTALL_ROOT: installRoot,
      },
      encoding: 'utf8',
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unified Gateway smoke failed with exit code ${result.status}`);
  }
  process.stdout.write(`Unified Gateway smoke passed with isolated root ${installRoot}\n`);
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
