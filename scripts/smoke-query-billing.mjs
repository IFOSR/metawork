import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const vitest = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const files = [
  'tests/acceptance/query-billing-lifecycle.test.ts',
  'tests/billing/consumption-outbox-recovery.test.ts',
  'tests/storage/migrations.test.ts',
  'tests/gateway/read-only-query-handler.test.ts',
  'tests/gateway/feishu-gateway-session-port.test.ts',
  'tests/management/web-gateway-session-runtime.test.ts',
];

const result = spawnSync(process.execPath, [vitest, 'run', ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, METAWORK_QUERY_BILLING_FAKE_EXTERNAL: '1' },
});
process.exit(result.status ?? 1);
