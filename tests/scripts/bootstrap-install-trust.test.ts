import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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

  it('executes a fully signed fixture only after both artifacts verify', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-bootstrap-functional-'));
    try {
      const fakeBin = join(root, 'bin');
      const resultPath = join(root, 'result.txt');
      mkdirSync(fakeBin, { recursive: true });
      writeExecutable(join(fakeBin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then printf 'Linux\\n'; else printf 'x86_64\\n'; fi
`);
      writeExecutable(join(fakeBin, 'curl'), `#!/bin/sh
case "$2" in
  fixture://manifest) cp "$BOOTSTRAP_MANIFEST_FIXTURE" "$4" ;;
  fixture://runtime) cp "$BOOTSTRAP_RUNTIME_FIXTURE" "$4" ;;
  fixture://planner) cp "$BOOTSTRAP_PLANNER_FIXTURE" "$4" ;;
  *) exit 9 ;;
esac
`);
      writeExecutable(join(fakeBin, 'tar'), `#!/bin/sh
target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then target="$2"; shift 2; continue; fi
  shift
done
if echo "$target" | grep -q '/runtime$'; then
  mkdir -p "$target/dist"
  cat > "$target/dist/install-cli.js" <<'NODE'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BOOTSTRAP_RESULT, process.argv.slice(2).join('\\n'));
NODE
else
  mkdir -p "$target/packages/coding-agent/dist"
  printf 'planner fixture\\n' > "$target/packages/coding-agent/dist/cli.js"
fi
`);

      const fixtureRoot = resolve('tests/fixtures/bootstrap');
      const result = spawnSync('bash', [
        resolve('scripts/bootstrap-install.sh'),
        '1.2.0-preview.0',
        'fixture://manifest',
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
          HOME: root,
          BOOTSTRAP_MANIFEST_FIXTURE: join(fixtureRoot, 'manifest.json'),
          BOOTSTRAP_RUNTIME_FIXTURE: join(fixtureRoot, 'runtime.artifact'),
          BOOTSTRAP_PLANNER_FIXTURE: join(fixtureRoot, 'planner.artifact'),
          BOOTSTRAP_RESULT: resultPath,
        },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(resultPath, 'utf8')).toContain([
        'install',
        '1.2.0-preview.0',
        '--source-root',
      ].join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
