import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  renderLauncher,
  resolveProviderConfig,
} from '../../scripts/native-install-lib.mjs';

describe('native AnyFusion installer', () => {
  it('renders an isolated launcher that keeps the user current directory', () => {
    const launcher = renderLauncher({
      runtimeRoot: '/opt/metawork',
      plannerRoot: '/opt/metawork/planner/AnyFusion-Pi',
      configHome: '/Users/test/.config/anyfusion',
    });

    expect(launcher).toContain('export METACLAW_PLANNER_WORKDIR="$PWD"');
    expect(launcher).toContain('export METACLAW_EXECUTOR_BACKEND=worktree');
    expect(launcher).toContain('unset METACLAW_STANDBY_TUI');
    expect(launcher).toContain(
      'ANYFUSION_PI_SOURCE_ROOT="${ANYFUSION_PI_SOURCE_ROOT:-/opt/metawork/planner/AnyFusion-Pi}"',
    );
    expect(launcher).toContain('$ANYFUSION_PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js');
    expect(launcher).not.toContain('npm install -g');
    expect(launcher).not.toContain('HOME="$HOME/.codex"');
    expect(launcher).not.toContain('HOME="$HOME/.pi"');
  });

  it('requires explicit provider configuration without reading Codex or Pi homes', () => {
    expect(resolveProviderConfig({
      ANYFUSION_PROVIDER_KEY: 'test-key',
      ANYFUSION_PROVIDER_URL: 'https://provider.example/v1',
    })).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://provider.example/v1',
    });
    expect(() => resolveProviderConfig({})).toThrow('ANYFUSION_PROVIDER_KEY');
  });

  it('keeps every setup path free of global Codex or Pi installation', async () => {
    const [setup, nativeInstaller] = await Promise.all([
      readFile(new URL('../../setup.sh', import.meta.url), 'utf8'),
      readFile(new URL('../../scripts/install-native-macos.mjs', import.meta.url), 'utf8'),
    ]);

    expect(setup).not.toContain('npm install -g');
    expect(nativeInstaller).not.toContain('npm install -g');
    expect(nativeInstaller).not.toContain("requireCommand('codex')");
    expect(nativeInstaller).not.toContain("requireCommand('pi')");
    expect(nativeInstaller).toContain("join(runtimeRoot, 'planner', 'AnyFusion-Pi')");
    expect(nativeInstaller).not.toContain("join(runtimeRoot, '..', 'AnyFusion-Pi')");
  });
});
