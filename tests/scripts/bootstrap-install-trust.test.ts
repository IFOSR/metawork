import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalizeReleaseManifestPayload } from '../../src/installation/release-manifest.js';

describe('bootstrap installer trust boundary', () => {
  it('verifies the signed manifest and artifacts before extraction or execution', () => {
    const script = readFileSync(resolve('scripts/bootstrap-install.sh'), 'utf8');
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

  it('checks target, trust, integrity, and vendored Planner identity contracts', () => {
    const script = readFileSync(resolve('scripts/bootstrap-install.sh'), 'utf8');
    for (const contract of [
      'expiresAt',
      'platform',
      'arch',
      'channel',
      'sha256',
      'byteSize',
      'signature',
      'keyId',
      'vendored Planner source',
      'vendored Planner revision',
    ]) {
      expect(script).toContain(contract);
    }
  });

  it('uses the MetaWork release channel with a fail-closed AnyFusion alias', () => {
    const script = readFileSync(resolve('scripts/bootstrap-install.sh'), 'utf8');

    expect(script).toContain('METAWORK_RELEASE_CHANNEL');
    expect(script).toContain('ANYFUSION_RELEASE_CHANNEL');
    expect(script).toContain(
      'METAWORK_RELEASE_CHANNEL conflicts with compatibility variable ANYFUSION_RELEASE_CHANNEL',
    );
  });

  it('executes a fully signed fixture only after every artifact verifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-bootstrap-functional-'));
    try {
      const fakeBin = join(root, 'bin');
      const resultPath = join(root, 'result.txt');
      mkdirSync(fakeBin, { recursive: true });
      writeExecutable(join(fakeBin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then printf 'Linux\\n'; else printf 'x86_64\\n'; fi
`);
      const artifacts = {
        runtime: 'signed runtime artifact fixture',
        planner: 'signed planner artifact fixture',
        memory: 'signed memory engine artifact ',
      };
      for (const [name, content] of Object.entries(artifacts)) {
        writeFileSync(join(root, `${name}.artifact`), content);
      }
      const keys = generateKeyPairSync('ed25519');
      const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const artifact = (name: string) => {
        const bytes = readFileSync(join(root, `${name}.artifact`));
        const source = name === 'memory'
          ? 'https://github.com/TencentCloud/TencentDB-Agent-Memory.git'
          : 'https://github.com/IFOSR/metawork.git';
        return {
          source,
          revision: name === 'memory' ? 'memory-revision' : 'fixture-metawork-revision',
          url: `fixture://${name}`,
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      };
      const unsigned = {
        manifestSchemaVersion: 1,
        releaseId: '1.2.0-preview.0',
        channel: 'preview',
        publishedAt: '2026-08-14T00:00:00.000Z',
        expiresAt: '2036-08-14T00:00:00.000Z',
        minimumInstallerVersion: '1.2.0',
        minimumNodeVersion: '22.19.0',
        platform: 'linux',
        arch: 'x64',
        metawork: artifact('runtime'),
        planner: artifact('planner'),
        memory: artifact('memory'),
        compatibility: {
          configurationSchema: 2,
          plannerHostProtocol: 2,
          planningPlanSchema: 8,
          planningPlanSchemaHash: 'fixture-schema-hash',
          workGraphSchema: 7,
          kernelDecisionSchema: 6,
          databaseSchema: 31,
        },
        previousCompatibleRelease: null,
      };
      const signature = sign(
        null,
        Buffer.from(canonicalizeReleaseManifestPayload(unsigned)),
        keys.privateKey,
      ).toString('base64');
      writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({
          ...unsigned,
          signature: { algorithm: 'ed25519', keyId: 'fixture-release-key', value: signature },
        }),
      );
      writeExecutable(join(fakeBin, 'curl'), `#!/bin/sh
case "$2" in
  fixture://manifest) cp "$BOOTSTRAP_MANIFEST_FIXTURE" "$4" ;;
  fixture://runtime) cp "$BOOTSTRAP_RUNTIME_FIXTURE" "$4" ;;
  fixture://planner) cp "$BOOTSTRAP_PLANNER_FIXTURE" "$4" ;;
  fixture://memory) cp "$BOOTSTRAP_MEMORY_FIXTURE" "$4" ;;
  *) exit 9 ;;
esac
`);
      writeExecutable(join(fakeBin, 'tar'), `#!/bin/sh
archive=''
target=''
previous=''
for argument in "$@"; do
  if [ "$previous" = "-C" ]; then target="$argument"; fi
  case "$argument" in
    *.tar.gz|*.zip) archive="$argument" ;;
  esac
  previous="$argument"
done
case "$archive" in
  *memory*)
    mkdir -p "$target/memory/tdai/dist/gateway"
    printf 'engine fixture\\n' > "$target/memory/tdai/dist/gateway/server.js"
    ;;
  *release*)
    mkdir -p "$target/dist"
    cat > "$target/dist/install-cli.js" <<'NODE'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BOOTSTRAP_RESULT, process.argv.slice(2).join('\\n'));
NODE
    ;;
  *)
    mkdir -p "$target/packages/coding-agent/dist"
    printf 'planner fixture\\n' > "$target/packages/coding-agent/dist/cli.js"
    ;;
esac
`);

      const result = spawnSync('bash', [
        resolve('scripts/bootstrap-install.sh'),
        '1.2.0-preview.0',
        'fixture://manifest',
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
          HOME: root,
          BOOTSTRAP_MANIFEST_FIXTURE: join(root, 'manifest.json'),
          BOOTSTRAP_RUNTIME_FIXTURE: join(root, 'runtime.artifact'),
          BOOTSTRAP_PLANNER_FIXTURE: join(root, 'planner.artifact'),
          BOOTSTRAP_MEMORY_FIXTURE: join(root, 'memory.artifact'),
          BOOTSTRAP_RESULT: resultPath,
          METAWORK_RELEASE_CHANNEL: 'preview',
          METAWORK_INSTALL_TRUSTED_KEY_ID: 'fixture-release-key',
          METAWORK_INSTALL_TRUSTED_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      const installed = readFileSync(resultPath, 'utf8');
      expect(installed).toContain([
        'install',
        '1.2.0-preview.0',
        '--source-root',
      ].join('\n'));
      expect(installed).toContain('--memory-root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
