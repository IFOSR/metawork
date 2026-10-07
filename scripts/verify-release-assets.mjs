import { createHash, verify } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
export const DESKTOP_TARGETS = ['darwin-arm64', 'darwin-x64'];
export const TRUSTED_KEY_ID = 'metawork-release-2026-03';
export const TRUSTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFUfe0iqiIaYSMGiyywur13FpzoXRQBqAZB0gzEi2DE0=
-----END PUBLIC KEY-----`;

export function compareReleaseIds(left, right) {
  const leftVersion = parseReleaseId(left);
  const rightVersion = parseReleaseId(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] - rightVersion.core[index];
    }
  }
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return 1;
    if (rightPart === undefined) return -1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseReleaseId(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value);
  if (!match) throw new Error(`invalid release id: ${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  };
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function digest(stream) {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of stream) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  return { byteSize, sha256: hash.digest('hex') };
}

function assertArtifact(actual, expected, name) {
  if (actual.byteSize !== expected.byteSize) throw new Error(`${name}: size mismatch`);
  if (actual.sha256 !== expected.sha256) throw new Error(`${name}: hash mismatch`);
}

export async function verifyReleaseAssets(directory, tag, options = {}) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag)) throw new Error('invalid release tag');
  const now = options.now ?? Date.now();
  const manifests = [];
  const files = [];
  let identity;
  for (const target of RELEASE_TARGETS) {
    const name = `manifest.${target}.json`;
    const body = readFileSync(join(directory, name));
    const manifest = JSON.parse(body);
    const { signature, ...payload } = manifest;
    if (signature?.algorithm !== 'ed25519' || signature.keyId !== TRUSTED_KEY_ID
      || !verify(null, Buffer.from(stable(payload)), options.trustedPublicKey ?? TRUSTED_PUBLIC_KEY,
        Buffer.from(signature.value, 'base64'))) {
      throw new Error(`${target}: signature verification failed`);
    }
    if (manifest.manifestSchemaVersion !== 1 || manifest.channel !== 'stable'
      || `${manifest.platform}-${manifest.arch}` !== target
      || !Number.isFinite(Date.parse(manifest.publishedAt))
      || !(Date.parse(manifest.expiresAt) > now)) {
      throw new Error(`${target}: invalid manifest metadata or expired manifest`);
    }
    const revision = manifest.metawork?.revision;
    if (!/^[a-f0-9]{7,40}$/.test(revision)
      || (options.sourceCommit && !options.sourceCommit.startsWith(revision))
      || manifest.releaseId !== `${tag.slice(1)}-build-${revision.slice(0, 7)}`
      || manifest.planner?.revision !== revision
      || !['https://github.com/IFOSR/metawork', 'https://github.com/IFOSR/metawork.git']
        .includes(manifest.metawork.source)
      || manifest.planner.source !== manifest.metawork.source) {
      throw new Error(`${target}: release/revision identity mismatch`);
    }
    const currentIdentity = stable({
      releaseId: manifest.releaseId, revision, compatibility: manifest.compatibility,
      minimumInstallerVersion: manifest.minimumInstallerVersion,
      minimumNodeVersion: manifest.minimumNodeVersion,
    });
    identity ??= currentIdentity;
    if (identity !== currentIdentity) throw new Error(`${target}: mixed release set`);
    files.push({ name, byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    for (const kind of ['metawork', 'planner']) {
      const artifact = manifest[kind];
      const expectedName = `${kind}-${manifest.releaseId}-${target}${target.startsWith('win32') ? '.zip' : '.tar.gz'}`;
      const expectedUrl = `https://github.com/IFOSR/metawork/releases/download/${tag}/${expectedName}`;
      if (![expectedName, expectedUrl].includes(artifact.url) || !Number.isSafeInteger(artifact.byteSize)
        || artifact.byteSize <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new Error(`${target}: invalid ${kind} artifact contract`);
      }
      if (!statSync(join(directory, expectedName)).isFile()) throw new Error('archive is not a file');
      assertArtifact(await digest(createReadStream(join(directory, expectedName))), artifact, expectedName);
      files.push({ name: expectedName, byteSize: artifact.byteSize, sha256: artifact.sha256 });
    }
    manifests.push(manifest);
  }
  if (options.requireDesktop !== false) {
    for (const target of DESKTOP_TARGETS) {
      const name = `desktop-manifest.${target}.json`;
      const body = readFileSync(join(directory, name));
      const { signature, ...desktop } = JSON.parse(body);
      if (signature?.algorithm !== 'ed25519' || signature.keyId !== TRUSTED_KEY_ID
        || !verify(null, Buffer.from(stable(desktop)), options.trustedPublicKey ?? TRUSTED_PUBLIC_KEY,
          Buffer.from(signature.value, 'base64'))) throw new Error(`${target}: Desktop signature verification failed`);
      const runtime = manifests.find(manifest => `${manifest.platform}-${manifest.arch}` === target);
      if (desktop.schemaVersion !== 1 || desktop.tag !== tag || desktop.target !== target
        || desktop.desktopVersion !== tag.slice(1) || desktop.releaseId !== runtime.releaseId
        || !/^[a-f0-9]{40}$/.test(desktop.sourceCommit)
        || !desktop.sourceCommit.startsWith(runtime.metawork.revision)
        || (options.sourceCommit && desktop.sourceCommit !== options.sourceCommit)
        || desktop.development !== false) throw new Error(`${target}: Desktop release identity mismatch`);
      const expectedName = `MetaWork-${target}.dmg`;
      if (desktop.artifact?.name !== expectedName || !Number.isSafeInteger(desktop.artifact.byteSize)
        || desktop.artifact.byteSize <= 0 || !/^[a-f0-9]{64}$/.test(desktop.artifact.sha256)) {
        throw new Error(`${target}: invalid Desktop artifact contract`);
      }
      assertArtifact(await digest(createReadStream(join(directory, expectedName))), desktop.artifact, expectedName);
      files.push({ name, byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex') }, desktop.artifact);
    }
    for (const name of ['install.sh', 'install.ps1']) {
      const body = readFileSync(join(directory, name));
      if (!body.length) throw new Error(`missing installer: ${name}`);
      files.push({ name, byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    }
  }
  return { releaseId: manifests[0].releaseId, manifests, files };
}

export async function verifyPublishedRelease(release, baseUrl) {
  if (!baseUrl.startsWith('https://')) throw new Error('public verification requires HTTPS');
  for (const file of release.files) {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${file.name}`, {
      signal: AbortSignal.timeout(300_000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok || !response.body) throw new Error(`${file.name}: HTTP ${response.status}`);
    assertArtifact(await digest(response.body), file, file.name);
    console.log(`Verified HTTPS ${file.name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, tag, baseUrl] = process.argv.slice(2);
  const release = await verifyReleaseAssets(directory, tag, { sourceCommit: process.env.GITHUB_SHA });
  if (baseUrl) await verifyPublishedRelease(release, baseUrl);
  console.log(`Verified ${release.releaseId}: ${release.files.length} assets including both Desktop installers`);
}
