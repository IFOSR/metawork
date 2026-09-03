import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve('scripts/install.sh'), 'utf8');

describe('user install script contracts', () => {
  it('verifies the signed manifest and artifacts before extraction or execution', () => {
    const manifestDownload = script.indexOf('curl -fsSL "$MANIFEST_URL"');
    const signatureVerification = script.indexOf('verify_manifest "$MANIFEST_PATH"');
    const artifactDownload = script.indexOf('curl -fsSL "$RUNTIME_URL"');
    const artifactVerification = script.indexOf('verify_artifact "$MANIFEST_PATH"');
    const extraction = script.indexOf('tar -xzf');
    const installerExecution = script.indexOf('dist/install-cli.js');

    expect(script).toContain('TRUSTED_RELEASE_KEY_ID=');
    expect(script).toContain('TRUSTED_RELEASE_PUBLIC_KEY=');
    expect(script).toContain('REVOKED_RELEASE_KEY_IDS=');
    expect(manifestDownload).toBeGreaterThan(-1);
    expect(signatureVerification).toBeGreaterThan(manifestDownload);
    expect(artifactDownload).toBeGreaterThan(signatureVerification);
    expect(artifactVerification).toBeGreaterThan(artifactDownload);
    expect(extraction).toBeGreaterThan(artifactVerification);
    expect(installerExecution).toBeGreaterThan(extraction);
  });

  it('updates existing installations in place instead of reinstalling', () => {
    expect(script).toContain('INSTALL_COMMAND="install"');
    expect(script).toContain('INSTALL_COMMAND="update"');
    expect(script.indexOf('INSTALL_COMMAND="update"'))
      .toBeGreaterThan(script.indexOf('app/current'));
    // Updates route through the offline installer transaction that preserves
    // configuration, secrets, and task data.
    expect(script).toContain('"$INSTALL_COMMAND" "$RELEASE_ID"');
  });

  it('is idempotent when the published release is already active', () => {
    const currentRelease = script.indexOf('CURRENT_RELEASE=');
    const alreadyInstalled = script.indexOf('already installed');
    expect(currentRelease).toBeGreaterThan(-1);
    expect(alreadyInstalled).toBeGreaterThan(currentRelease);
    expect(script).toContain('exit 0');
  });

  it('reconnects the terminal for the provider wizard under curl | bash', () => {
    expect(script).toContain('exec < /dev/tty');
    expect(script).toContain('[ ! -t 0 ]');
  });

  it('honors MetaWork environment overrides with fail-closed AnyFusion aliases', () => {
    expect(script).toContain('METAWORK_INSTALL_MANIFEST');
    expect(script).toContain('METAWORK_INSTALL_ROOT');
    expect(script).toContain('METAWORK_INSTALL_TRUSTED_KEY_ID');
    expect(script).toContain('METAWORK_INSTALL_TRUSTED_PUBLIC_KEY');
    expect(script).toContain(
      'METAWORK_RELEASE_CHANNEL conflicts with compatibility variable ANYFUSION_RELEASE_CHANNEL',
    );
    expect(script).toContain(
      'METAWORK_INSTALL_ROOT conflicts with compatibility variable ANYFUSION_INSTALL_ROOT',
    );
  });

  it('fails closed on unsupported platforms with a Windows pointer', () => {
    expect(script).toContain('unsupported platform');
    expect(script).toContain('WSL2 or Docker');
  });

  it('supports offline uninstall with managed-launcher ownership checks', () => {
    expect(script).toContain('--uninstall');
    expect(script).toContain('--purge');
    // Uninstall must not require the release host.
    const uninstallBranch = script.indexOf('if [ "$UNINSTALL" = true ]');
    const manifestDownload = script.indexOf('curl -fsSL "$MANIFEST_URL"');
    expect(uninstallBranch).toBeGreaterThan(-1);
    expect(uninstallBranch).toBeLessThan(manifestDownload);
    // Only launchers carrying the managed marker are removed.
    expect(script).toContain('managed launcher');
    expect(script).toContain('legacy-*');
    // A running Server is stopped before data removal.
    expect(script).toContain('runtime.lock');
    expect(script).toContain('server stop');
    // Read-only release trees regain write access before rm -rf.
    expect(script).toContain('chmod -R u+w');
  });
});
