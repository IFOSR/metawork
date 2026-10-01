import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_TARGETS, verifyPublishedRelease, verifyReleaseAssets } from './verify-release-assets.mjs';

function snapshot(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
    if (!stat.isFile()) throw new Error(`refusing to replace non-file: ${path}`);
    return { body: readFileSync(path), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replace(path, state) {
  if (!state) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  if (state.link !== undefined) symlinkSync(state.link, temporary);
  else writeFileSync(temporary, state.body, { mode: state.mode });
  renameSync(temporary, path);
}

// The caller holds the server's flock for activation AND public verification.
export async function activateRelease(root, assets, tag, options = {}) {
  const release = await verifyReleaseAssets(assets, tag, options);
  mkdirSync(root, { recursive: true });
  const names = ['latest', 'install.sh', 'install.ps1'];
  const before = Object.fromEntries(names.map((name) => [name, snapshot(join(root, name))]));
  if (before.latest && before.latest.link === undefined) throw new Error('latest must be a symlink');
  const previous = before.latest ? realpathSync(join(root, 'latest')) : null;
  if (previous) {
    const candidateTime = Math.min(...release.manifests.map((manifest) => Date.parse(manifest.publishedAt)));
    for (const target of RELEASE_TARGETS) {
      const path = join(previous, `manifest.${target}.json`);
      if (existsSync(path)) {
        const active = JSON.parse(readFileSync(path, 'utf8'));
        if (Date.parse(active.publishedAt) > candidateTime && active.releaseId !== release.releaseId) {
          throw new Error('refusing to deploy an older release over the active release');
        }
      }
    }
  }
  const candidate = mkdtempSync(join(root, `${release.releaseId}-deployment-`));
  for (const file of [...release.files.map(({ name }) => name), 'install.sh', 'install.ps1']) {
    copyFileSync(join(assets, file), join(candidate, file));
    chmodSync(join(candidate, file), file === 'install.sh' ? 0o755 : 0o644);
  }
  chmodSync(candidate, 0o755);
  await verifyReleaseAssets(candidate, tag, options);

  // A client may have fetched the previous manifest just before latest changes.
  // Keep those immutable archive names reachable, without copying old manifests.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || join(root, entry.name) === candidate) continue;
    for (const file of readdirSync(join(root, entry.name))) {
      if (!/\.(tar\.gz|zip)$/.test(file) || existsSync(join(candidate, file))) continue;
      const old = realpathSync(join(root, entry.name, file));
      symlinkSync(old, join(candidate, file));
    }
  }
  const record = {
    releaseId: release.releaseId, previous,
    activatedAt: new Date().toISOString(), status: 'verifying',
  };
  const recordPath = join(candidate, 'deployment.json');
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  try {
    replace(join(root, 'latest'), { link: candidate });
    for (const name of ['install.sh', 'install.ps1']) {
      replace(join(root, name), { link: `latest/${name}` });
    }
    await (options.verifyPublic ?? verifyPublishedRelease)(
      candidate, release, options.publicBaseUrl,
    );
    record.status = 'verified';
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    return { ...release, candidate, previous };
  } catch (error) {
    for (const name of names) replace(join(root, name), before[name]);
    record.status = 'rolled_back';
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, assets, tag, publicBaseUrl] = process.argv.slice(2);
  if (!root || !assets || !tag || !publicBaseUrl?.startsWith('https://')) {
    throw new Error('usage: activate-release.mjs ROOT ASSETS TAG HTTPS_BASE_URL (under flock)');
  }
  const result = await activateRelease(resolve(root), resolve(assets), tag, { publicBaseUrl });
  console.log(`Activated and publicly verified ${result.releaseId}; previous=${result.previous}`);
}
