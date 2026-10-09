// Build this checkout's packaged macOS regression candidate. Only the reviewed
// relocatable tools come from an existing signed download, never its Server/Web.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stable, TRUSTED_KEY_ID, TRUSTED_PUBLIC_KEY } from './verify-release-assets.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64'); // The retained published Desktop architecture.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REF, 'refs/heads/feat/windows-desktop');
assert.ok(process.argv[2] && process.argv[3], 'Base download and new candidate directory required');
const download = resolve(process.argv[2]);
const candidate = resolve(process.argv[3]);
const source = process.cwd();
const testModel = process.env.METAWORK_TEST_MODEL;
delete process.env.METAWORK_TEST_MODEL;
const run = (command, args, cwd = source, env = process.env) => execFileSync(command, args,
  { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
assert.equal(sourceCommit, process.env.GITHUB_SHA);
const { signature, ...manifest } = JSON.parse(await readFile(join(download, 'desktop-manifest.darwin-arm64.json'), 'utf8'));
assert.equal(signature.algorithm, 'ed25519');
assert.equal(signature.keyId, TRUSTED_KEY_ID);
assert.ok(verify(null, Buffer.from(stable(manifest)), TRUSTED_PUBLIC_KEY, Buffer.from(signature.value, 'base64')));
assert.equal(manifest.target, 'darwin-arm64');
assert.equal(manifest.artifact.name, 'MetaWork-darwin-arm64.dmg');
const dmg = join(download, manifest.artifact.name);
const bytes = await readFile(dmg);
assert.equal(bytes.length, manifest.artifact.byteSize);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.artifact.sha256);
await mkdir(candidate, { recursive: false });
const evidence = resolve('.tmp/windows-desktop-validation/macos-packaged');
await mkdir(evidence, { recursive: true });
const mount = join(candidate, 'base-mount');
await mkdir(mount);
const tools = join(candidate, 'tools');
let mounted = false;
const signingKey = join(candidate, 'ephemeral.private.pem');
try {
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  mounted = true;
  await cp(join(mount, 'MetaWork.app/Contents/Resources/payload/metawork/desktop-tools'), tools,
    { recursive: true, dereference: true });
  run('/usr/bin/hdiutil', ['detach', mount]); mounted = false;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'ephemeral-macos-ci';
  const trusted = join(candidate, 'ephemeral-trusted-keys.json');
  await writeFile(signingKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(trusted, JSON.stringify({ [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) }));
  for (const cwd of [source, join(source, 'planner/AnyFusion-Pi')]) {
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', ...(cwd === source ? [] : ['--ignore-scripts'])], cwd);
  }
  const artifacts = join(candidate, 'archives');
  run(process.execPath, ['scripts/package-release.mjs', '--out-dir', artifacts,
    '--artifact-base-url', pathToFileURL(artifacts).href, '--release-id', `0.1.5-macos-ci-${sourceCommit.slice(0, 12)}`,
    '--channel', 'preview', '--key-id', keyId, '--signing-key', signingKey]);
  const resources = join(candidate, 'resources');
  const env = { ...process.env, METAWORK_DESKTOP_INTERNAL: '1', METAWORK_DESKTOP_RESOURCES: resources,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  run(process.execPath, ['apps/desktop/packaging/prepare-runtime.mjs', '--artifacts', artifacts,
    '--output', resources, '--node-root', join(tools, 'node'), '--git-root', join(tools, 'git'),
    '--executor-root', join(tools, 'executor'), '--trusted-keys', trusted, '--signing-key', signingKey,
    '--key-id', keyId, '--source-commit', sourceCommit, '--development', 'true'], source, env);
  const desktop = join(source, 'apps/desktop');
  run(process.execPath, ['packaging/build.mjs'], desktop, env);
  const shell = join(candidate, 'shell');
  run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', 'packaging/electron-builder.config.mjs',
    '--mac', '--arm64', '--dir', '--publish', 'never', '--config.directories.output', shell], desktop, env);
  // Explicitly short isolated roots keep Unix socket paths within their limit.
  const smokeRoot = `/tmp/mwpc-${sourceCommit.slice(0, 10)}`;
  execFileSync(process.execPath, ['tests/packaged-install-smoke.mjs', join(shell, 'mac-arm64/MetaWork.app'), evidence],
    { cwd: desktop, stdio: 'inherit', timeout: 2_100_000, env: { ...env, METAWORK_PACKAGED_SMOKE_ROOT: smokeRoot,
      METAWORK_PACKAGED_REAL_TASK: '1', METAWORK_TEST_MODEL: testModel ?? '' } });
  await writeFile(join(evidence, 'candidate.json'), JSON.stringify({ sourceCommit, platform: process.platform, arch: process.arch,
    toolsFromVerifiedDmg: manifest.artifact.sha256, packaged: true, realModelTasks: true, published: false }, null, 2));
} finally {
  if (mounted) run('/usr/bin/hdiutil', ['detach', mount]);
  await rm(signingKey, { force: true });
}
