import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('source setup product environment', () => {
  it('promotes MetaWork variables while retaining bounded AnyFusion aliases', () => {
    const source = readFileSync('setup.sh', 'utf8');

    expect(source).toContain('resolve_product_env');
    expect(source).toContain('METAWORK_PROVIDER_KEY');
    expect(source).toContain('METAWORK_PROVIDER_URL');
    expect(source).toContain('METAWORK_PROVIDER_MODEL');
    expect(source).toContain('METAWORK_PROVIDER_REGION');
    expect(source).toContain('METAWORK_SECRET_STORE');
    expect(source).toContain('ANYFUSION_PROVIDER_KEY');
    expect(source).toContain('ANYFUSION_PI_SOURCE_ROOT');
    expect(source).toContain('conflicts with compatibility variable');
  });

  it('keeps the macOS installer aligned with the canonical product variables', () => {
    const source = readFileSync('scripts/install-native-macos.mjs', 'utf8');

    // Provider credentials are no longer required up front: fresh installs
    // collect them through the interactive wizard inside install-cli, so the
    // macOS wrapper only resolves the remaining setup variables.
    expect(source).toContain('METAWORK_PROVIDER_MODEL');
    expect(source).toContain('METAWORK_PROVIDER_REGION');
    expect(source).toContain('METAWORK_SECRET_STORE');
    expect(source).not.toContain('requiredEnvironment');
    expect(source).toContain('MetaWork native installation failed');
    expect(source).toContain('ANYFUSION_PI_SOURCE_ROOT');
    expect(source).toContain("const installCommand = existsSync(join(installRoot, 'app', 'current'))");
    expect(source).toContain('installCommand,');
  });

  it('updates an existing installation instead of retrying clean install', () => {
    const source = readFileSync('setup.sh', 'utf8');

    expect(source).toContain('INSTALL_COMMAND=update');
    expect(source).toContain('export METAWORK_INSTALL_ROOT="$INSTALL_ROOT"');
    expect(source).toContain('export ANYFUSION_INSTALL_ROOT="$INSTALL_ROOT"');
    expect(source).toContain('"$INSTALL_COMMAND" "$RELEASE_ID"');
  });
});
