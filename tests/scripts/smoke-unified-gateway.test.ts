import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('unified Gateway smoke command', () => {
  it('uses an isolated installation root and runs the production boundary acceptance files', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const source = readFileSync('scripts/smoke-unified-gateway.mjs', 'utf8');

    expect(packageJson.scripts['smoke:gateway']).toContain('smoke-unified-gateway.mjs');
    expect(source).toContain('mkdtempSync');
    expect(source).toContain('ANYFUSION_INSTALL_ROOT');
    expect(source).toContain('tests/architecture/unified-server-composition.test.ts');
    expect(source).toContain('tests/integration/unified-client-runtime.integration.test.ts');
    expect(source).toContain('tests/security/gateway-account-isolation.test.ts');
  });
});
