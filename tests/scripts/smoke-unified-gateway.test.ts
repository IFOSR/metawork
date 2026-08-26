import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('unified Gateway smoke command', () => {
  it('uses an isolated installation root and runs the production boundary acceptance files', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      name: string;
      private?: boolean;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const source = readFileSync('scripts/smoke-unified-gateway.mjs', 'utf8');

    expect(packageJson.scripts['smoke:gateway']).toContain('smoke-unified-gateway.mjs');
    expect(packageJson.scripts['smoke:metawork']).toContain('smoke-metaclaw-real-task.mjs');
    expect(packageJson.scripts['smoke:anyfusion']).toBe(packageJson.scripts['smoke:metawork']);
    expect(packageJson.scripts['smoke:metaclaw']).toBe(packageJson.scripts['smoke:metawork']);
    expect(packageJson.name).toBe('metawork');
    expect(packageJson.private).toBe(true);
    expect(packageJson.bin.metawork).toBe('./dist/index.js');
    expect(packageJson.bin.anyfusion).toBe('./dist/index.js');
    expect(packageJson.bin.metaclaw).toBe('./dist/index.js');
    expect(packageJson.bin['metawork-install']).toBe('./dist/install-cli.js');
    expect(packageJson.bin['anyfusion-install']).toBe('./dist/install-cli.js');
    expect(source).toContain('mkdtempSync');
    expect(source).toContain('METAWORK_INSTALL_ROOT');
    expect(source).not.toContain('ANYFUSION_INSTALL_ROOT');
    expect(source).toContain('tests/architecture/unified-server-composition.test.ts');
    expect(source).toContain('tests/integration/unified-client-runtime.integration.test.ts');
    expect(source).toContain('tests/security/gateway-account-isolation.test.ts');
  });
});
