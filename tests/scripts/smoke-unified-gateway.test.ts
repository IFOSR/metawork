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
    expect(packageJson.scripts['smoke:clients']).toContain(
      'independent-client-lifecycle.integration.test.ts',
    );
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
    expect(source).toContain("process.platform === 'darwin' ? '/tmp' : tmpdir()");
    expect(source).toContain("'mwg-'");
    expect(source).not.toContain("'metawork-gateway-smoke-'");
    expect(source).toContain('METAWORK_INSTALL_ROOT');
    expect(source).not.toContain('ANYFUSION_INSTALL_ROOT');
    expect(source).toContain('tests/architecture/unified-server-composition.test.ts');
    expect(source).toContain('tests/integration/unified-client-runtime.integration.test.ts');
    expect(source).toContain('tests/integration/independent-client-lifecycle.integration.test.ts');
    expect(source).toContain('tests/security/gateway-account-isolation.test.ts');
    expect(source).toContain('tests/security/workspace-directory-account-isolation.test.ts');
    expect(source).toContain('tests/integration/workspace-directory-recovery.integration.test.ts');
    expect(source).toContain('tests/gateway/workspace-gateway-runtime.test.ts');
    expect(source).toContain('tests/gateway/feishu-conversation-routing.test.ts');
    expect(source).toContain('tests/gateway/feishu-gateway-session-port.test.ts');
    expect(source).toContain('tests/gateway/gateway-load.test.ts');
    expect(source).toContain('tests/server/server-lifecycle.test.ts');
    expect(source).toContain('tests/client/web-client-launcher.test.ts');
    expect(source).toContain('planner/AnyFusion-Pi');
    expect(source).toContain('test/anyfusion-client-mode.test.ts');
    expect(source).toContain('test/metawork-conversation-selector.test.ts');
    expect(source).toContain('Planner TUI acceptance');
    expect(source).toContain('dist/install-cli.js');
    expect(source).toContain("startServer('start')");
    expect(source).toContain("startServer('restart')");
    expect(source).toContain("await runServerCommand('Server stop', 'stop')");
    expect(source).not.toContain("runSync('Server stop'");
    expect(source).toContain('await runWebClient(workspaceA)');
    expect(source).toContain('await fetch(url)');
    expect(source).toContain("'--no-open'");
    expect(source).toContain('GatewaySocketTransport');
    expect(source).toContain('workspace-a');
    expect(source).toContain('workspace-b');
    expect(source).toContain('Native multi-client process acceptance');
    expect(source).toContain('removeTree(smokeRoot)');
    expect(source).toContain("spawnSync('chmod', ['-R', 'u+w', path])");
    expect(source).not.toContain('scripted-gateway-session.test.ts');
  });
});
