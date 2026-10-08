// Disposable CI only: package the formal Runtime/Planner, then validate the
// combined Desktop resource tree. This creates no installer or release.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.GITHUB_REF !== 'refs/heads/feat/windows-desktop') {
  throw new Error('Disposable Windows x64 implementation-branch runner required');
}
if (!process.argv[2] || !process.argv[3]) throw new Error('Tool directory and new candidate directory required');
const tools = resolve(process.argv[2]);
const candidate = resolve(process.argv[3]);
const source = process.cwd();
const node = process.execPath;
const npm = join(dirname(node), 'node_modules/npm/bin/npm-cli.js');
function run(command, args, cwd = source, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}
const sourceCommit = run('git.exe', ['rev-parse', 'HEAD']).trim();
if (sourceCommit !== process.env.GITHUB_SHA) throw new Error('Candidate source commit mismatch');
const evidence = resolve('.tmp/windows-desktop-validation/candidate');
await mkdir(evidence, { recursive: true });
await mkdir(candidate, { recursive: false });
const keyPath = join(candidate, 'ephemeral.private.pem');
try {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'ephemeral-windows-ci';
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const trusted = join(candidate, 'ephemeral-trusted-keys.json');
  await writeFile(trusted, JSON.stringify({ [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) }));
  // This checkout is discarded after CI. Never prune a developer installation.
  for (const cwd of [source, join(source, 'planner/AnyFusion-Pi')]) {
    run(node, [npm, 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
  }
  const artifacts = join(candidate, 'archives');
  run(node, ['scripts/prepare-windows-pageant.mjs', join(source, 'planner/AnyFusion-Pi/node_modules/ssh2')]);
  run(node, ['scripts/package-release.mjs', '--out-dir', artifacts,
    '--artifact-base-url', pathToFileURL(artifacts).href,
    '--release-id', `0.1.5-windows-ci-${sourceCommit.slice(0, 12)}`, '--channel', 'preview',
    '--key-id', keyId, '--signing-key', keyPath]);
  const resources = join(candidate, 'resources');
  run(node, ['apps/desktop/packaging/prepare-runtime.mjs', '--artifacts', artifacts, '--output', resources,
    '--node-root', join(tools, 'node'), '--git-root', join(tools, 'git'), '--executor-root', join(tools, 'executor'),
    '--trusted-keys', trusted, '--signing-key', keyPath, '--key-id', keyId, '--source-commit', sourceCommit,
    '--native-module', resolve('native/windows/build/Release/metawork_platform.node'), '--development', 'true'],
  source, { ...process.env, METAWORK_DESKTOP_INTERNAL: '1' });
  const descriptor = await readFile(join(resources, 'desktop-release.json'));
  await writeFile(join(evidence, 'resources.json'), JSON.stringify({ passed: true, sourceCommit,
    scope: 'windows-desktop-resource-payload', installerVerified: false, desktopSessionVerified: false,
    descriptorSha256: createHash('sha256').update(descriptor).digest('hex'),
    fileCount: Object.keys(JSON.parse(descriptor).files).length }, null, 2));
  console.log('Windows candidate resource payload verified; installer and GUI acceptance remain open.');
  run(join(tools, 'node/node.exe'), ['scripts/probe-windows-desktop-install.mjs', resources,
    join(candidate, 'isolated-installation'), join(evidence, 'isolated-install.json')]);
} finally {
  await rm(keyPath, { force: true });
}
