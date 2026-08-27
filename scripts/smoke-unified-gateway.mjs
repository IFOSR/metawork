import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const installRoot = mkdtempSync(join(tmpdir(), 'metawork-gateway-smoke-'));
const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const acceptanceFiles = [
  'tests/architecture/no-direct-client-session-paths.test.ts',
  'tests/architecture/unified-server-composition.test.ts',
  'tests/integration/unified-client-runtime.integration.test.ts',
  'tests/security/gateway-account-isolation.test.ts',
  'tests/gateway/server-lifecycle.test.ts',
  'tests/gateway/feishu-gateway-session-port.test.ts',
  'tests/integration/independent-client-lifecycle.integration.test.ts',
  'tests/client/tui-client-launcher.test.ts',
  'tests/client/web-client-launcher.test.ts',
  'tests/workspace/conversation-workspace-service.test.ts',
  'tests/management/web-launch-context.test.ts',
  'tests/management/web-gateway-session-runtime.test.ts',
  'tests/server/server-endpoint-manifest.test.ts',
  'tests/web/workspace-shell.test.ts',
];

try {
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', ...acceptanceFiles],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        METAWORK_INSTALL_ROOT: installRoot,
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
