import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyReleaseAssets } from './verify-release-assets.mjs';

const root = resolve(process.cwd());
const options = parseArgs(process.argv.slice(2));
const releaseTag = options.releaseTag ?? `v${readVersion()}`;
const sourceDir = resolve(options.sourceDir ?? join(root, 'dist-release'));
const installerDir = resolve(options.installerDir ?? join(root, 'scripts'));
const remote = options.remote ?? 'root@14.103.216.193';
const remoteRoot = '/root/metawork-release';
const publicBaseUrl = 'https://14.103.216.193/metawork-release';
const sshKey = options.sshKey ?? process.env.METAWORK_DEPLOY_KEY;
const localStage = mkdtempSync(join(tmpdir(), 'metawork-release-deploy-'));

try {
  const release = await verifyReleaseAssets(sourceDir, releaseTag);
  const deployFiles = [...release.files.map((file) => file.name), 'install.sh', 'install.ps1'];
  for (const name of deployFiles) {
    const source = release.files.some((file) => file.name === name)
      ? join(sourceDir, name)
      : join(installerDir, name);
    cpSync(source, join(localStage, name));
  }

  const releaseDir = validateReleaseId(release.releaseId);
  const remoteStage = `${remoteRoot}/.staging-${releaseDir}-${process.pid}`;
  runRemote(remote, sshKey, `set -eu
mkdir '${remoteStage}'
`);
  for (const name of ['verify-release-assets.mjs', 'activate-release.mjs']) {
    cpSync(join(root, 'scripts', name), join(localStage, name));
    deployFiles.push(name);
  }
  execFileSync('scp', [
    ...sshOptions(sshKey), ...deployFiles.map((name) => join(localStage, name)),
    `${remote}:${remoteStage}/`,
  ], { stdio: 'inherit' });

  runRemote(remote, sshKey, `set -eu
flock -w 1200 '${remoteRoot}/deploy.lock' node '${remoteStage}/activate-release.mjs' \\
  '${remoteRoot}' '${remoteStage}' '${releaseTag}' '${publicBaseUrl}'
rm -r -- '${remoteStage}'
`);

  console.log(`Published ${release.releaseId} to ${publicBaseUrl}/latest`);
} finally {
  rmSync(localStage, { recursive: true, force: true });
}

function readVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

function validateReleaseId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`invalid release id: ${value}`);
  }
  return value;
}

function parseArgs(args) {
  const result = {};
  const names = {
    'release-tag': 'releaseTag',
    'source-dir': 'sourceDir',
    'installer-dir': 'installerDir',
    remote: 'remote',
    'ssh-key': 'sshKey',
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = names[args[index]?.slice(2)];
    const value = args[index + 1];
    if (!key || !value || value.startsWith('--')) throw new Error(`invalid argument: ${args[index]}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function sshOptions(key) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'IdentitiesOnly=yes',
    ...(key ? ['-i', key] : []),
  ];
}

function runRemote(host, key, script) {
  execFileSync('ssh', [...sshOptions(key), host, script], { stdio: 'inherit' });
}
