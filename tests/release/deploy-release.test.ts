import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
const tag = 'v1.2.0-preview.6';
const releaseId = '1.2.0-preview.6-build-0064851';
const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'metawork-release-test-'));
  directories.push(directory);
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const artifact = (kind: string) => {
      const body = Buffer.from(`${kind}-${target}`);
      const url = `${kind}-${releaseId}-${target}${platform === 'win32' ? '.zip' : '.tar.gz'}`;
      writeFileSync(join(directory, url), body);
      return {
        source: 'https://github.com/IFOSR/metawork.git',
        revision: '0064851',
        url, byteSize: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    };
    const payload = {
      manifestSchemaVersion: 1, releaseId, channel: 'preview',
      publishedAt: '2026-09-30T17:00:00Z', expiresAt: '2099-12-31T00:00:00Z',
      minimumInstallerVersion: '1.2.0', minimumNodeVersion: '22.19.0',
      platform, arch, metawork: artifact('metawork'), planner: artifact('planner'),
      compatibility: { databaseSchema: 46 }, previousCompatibleRelease: null,
    };
    writeManifest(directory, target, payload);
  }
  return directory;
}

function writeManifest(directory: string, target: string, payload: object) {
  writeFileSync(join(directory, `manifest.${target}.json`), JSON.stringify({
    ...payload,
    signature: {
      algorithm: 'ed25519', keyId: 'metawork-release-2026-03',
      value: sign(null, Buffer.from(stable(payload)), privateKey).toString('base64'),
    },
  }));
}

async function verifier() {
  return import(/* @vite-ignore */ resolve('scripts/verify-release-assets.mjs'));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('complete release set verification', () => {
  it('accepts four signed targets and eight verified archives', async () => {
    const { verifyReleaseAssets } = await verifier();
    const result = await verifyReleaseAssets(fixture(), tag, { trustedPublicKey });
    expect(result.releaseId).toBe(releaseId);
    expect(result.manifests).toHaveLength(4);
    expect(result.files).toHaveLength(12);
  });

  it('rejects a missing Windows manifest', async () => {
    const directory = fixture();
    rmSync(join(directory, 'manifest.win32-x64.json'));
    const { verifyReleaseAssets } = await verifier();
    await expect(verifyReleaseAssets(directory, tag, { trustedPublicKey })).rejects.toThrow();
  });

  it('rejects an archive with the correct size but incorrect hash', async () => {
    const directory = fixture();
    const path = join(directory, `metawork-${releaseId}-linux-x64.tar.gz`);
    writeFileSync(path, Buffer.alloc(readFileSync(path).length));
    const { verifyReleaseAssets } = await verifier();
    await expect(verifyReleaseAssets(directory, tag, { trustedPublicKey })).rejects.toThrow(/hash/i);
  });

  it('rejects tampered manifest signatures', async () => {
    const directory = fixture();
    const path = join(directory, 'manifest.linux-x64.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.compatibility.databaseSchema = 999;
    writeFileSync(path, JSON.stringify(manifest));
    const { verifyReleaseAssets } = await verifier();
    await expect(verifyReleaseAssets(directory, tag, { trustedPublicKey })).rejects.toThrow(/signature/i);
  });

  it.each(['releaseId', 'revision', 'expired', 'path', 'compatibility'])(
    'rejects a signed but inconsistent %s',
    async (problem) => {
      const directory = fixture();
      const path = join(directory, 'manifest.linux-x64.json');
      const { signature: _, ...payload } = JSON.parse(readFileSync(path, 'utf8'));
      if (problem === 'releaseId') payload.releaseId = '1.2.0-preview.5-old';
      if (problem === 'revision') payload.planner.revision = 'wrong';
      if (problem === 'expired') payload.expiresAt = '2020-01-01T00:00:00Z';
      if (problem === 'path') payload.metawork.url = '../outside.tar.gz';
      if (problem === 'compatibility') payload.compatibility.databaseSchema = 38;
      writeManifest(directory, 'linux-x64', payload);
      const { verifyReleaseAssets } = await verifier();
      await expect(verifyReleaseAssets(directory, tag, { trustedPublicKey })).rejects.toThrow();
    },
  );
});

describe('release deployment workflow', () => {
  it('deploys after GitHub publication and supports explicit repair', () => {
    const build = readFileSync('.github/workflows/release-build.yml', 'utf8');
    const deploy = readFileSync('.github/workflows/deploy-installer.yml', 'utf8');
    const deployScript = readFileSync('scripts/deploy-release.mjs', 'utf8');
    expect(build).toContain('needs: publish');
    expect(build).toContain('uses: ./.github/workflows/deploy-installer.yml');
    expect(build).toContain('secrets: inherit');
    expect(deploy).toContain('workflow_call:');
    expect(deploy).toContain('gh release download');
    expect(deploy).toContain('scripts/install.ps1');
    expect(deploy).toContain('scripts/deploy-release.mjs');
    expect(deployScript).toContain('flock');
    expect(deploy).toContain('timeout-minutes: 60');
    expect(deployScript).toContain('Uploading verified release metadata');
    expect(deployScript).toContain('Downloading ${archiveFiles.length} release archives');
    expect(deployScript).toContain('Upload and remote download complete; activating');
    expect(deploy).not.toContain('::warning::could not fetch');
  });
});

describe('release server activation', () => {
  async function activationFixture() {
    const root = mkdtempSync(join(tmpdir(), 'metawork-server-test-'));
    directories.push(root);
    const previous = join(root, 'previous');
    mkdirSync(previous);
    writeFileSync(join(previous, 'old.tar.gz'), 'old download');
    writeFileSync(join(root, 'install.sh'), 'old installer');
    symlinkSync(previous, join(root, 'latest'));
    const assets = fixture();
    writeFileSync(join(assets, 'install.sh'), 'new Unix installer');
    writeFileSync(join(assets, 'install.ps1'), 'new Windows installer');
    const { activateRelease } = await import(/* @vite-ignore */ resolve('scripts/activate-release.mjs'));
    return { root, previous, assets, activateRelease };
  }

  it('activates both installers and keeps in-flight old archive downloads working', async () => {
    const { root, assets, activateRelease } = await activationFixture();
    await activateRelease(root, assets, tag, {
      trustedPublicKey,
      verifyPublic: async () => {
        expect(readFileSync(join(root, 'install.sh'), 'utf8')).toBe('new Unix installer');
        expect(readFileSync(join(root, 'install.ps1'), 'utf8')).toBe('new Windows installer');
        expect(readFileSync(join(root, 'latest', 'old.tar.gz'), 'utf8')).toBe('old download');
      },
    });
    expect(JSON.parse(readFileSync(join(root, 'latest', 'manifest.win32-x64.json'), 'utf8'))
      .releaseId).toBe(releaseId);
  });

  it('restores the pointer and original installer after public verification fails', async () => {
    const { root, previous, assets, activateRelease } = await activationFixture();
    await expect(activateRelease(root, assets, tag, {
      trustedPublicKey,
      verifyPublic: async () => { throw new Error('public download failed'); },
    })).rejects.toThrow('public download failed');
    expect(readlinkSync(join(root, 'latest'))).toBe(previous);
    expect(readFileSync(join(root, 'install.sh'), 'utf8')).toBe('old installer');
    expect(() => readFileSync(join(root, 'install.ps1'))).toThrow();
  });

  it('does not activate corrupted uploads', async () => {
    const { root, previous, assets, activateRelease } = await activationFixture();
    rmSync(join(assets, 'manifest.win32-x64.json'));
    await expect(activateRelease(root, assets, tag, { trustedPublicKey })).rejects.toThrow();
    expect(readlinkSync(join(root, 'latest'))).toBe(previous);
    expect(readFileSync(join(root, 'install.sh'), 'utf8')).toBe('old installer');
  });

  it('recovers a killed activation before accepting another deployment', async () => {
    const { root, previous, assets, activateRelease } = await activationFixture();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { activateRelease } from ${JSON.stringify(resolve('scripts/activate-release.mjs'))};
      setInterval(() => {}, 1000);
      await activateRelease(${JSON.stringify(root)}, ${JSON.stringify(assets)}, ${JSON.stringify(tag)}, {
        trustedPublicKey: ${JSON.stringify(trustedPublicKey)},
        verifyPublic: async () => {
          console.log('VERIFYING');
          await new Promise(() => {});
        },
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((accept, reject) => {
        child.stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('VERIFYING')) accept();
        });
        child.on('error', reject);
        child.on('exit', () => reject(new Error('activation exited before verification')));
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      expect(readlinkSync(join(root, 'latest'))).not.toBe(previous);
      rmSync(join(assets, 'manifest.win32-x64.json'));
      await expect(activateRelease(root, assets, tag, { trustedPublicKey })).rejects.toThrow();
      expect(readlinkSync(join(root, 'latest'))).toBe(realpathSync(previous));
      expect(readFileSync(join(root, 'install.sh'), 'utf8')).toBe('old installer');
      expect(() => readFileSync(join(root, 'install.ps1'))).toThrow();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('rejects downgrade even when an older version is rebuilt later', async () => {
    const { root, previous, assets, activateRelease } = await activationFixture();
    writeFileSync(join(previous, 'manifest.linux-x64.json'), JSON.stringify({
      releaseId: '1.2.0-preview.7-build-abcdef0', publishedAt: '2026-09-01T00:00:00Z',
    }));
    await expect(activateRelease(root, assets, tag, {
      trustedPublicKey, verifyPublic: async () => {},
    })).rejects.toThrow(/older release/i);
    expect(readlinkSync(join(root, 'latest'))).toBe(previous);
  });

  it('allows a newer release despite overlapping platform build timestamps', async () => {
    const { root, previous, assets, activateRelease } = await activationFixture();
    writeFileSync(join(previous, 'manifest.linux-x64.json'), JSON.stringify({
      releaseId: '1.2.0-preview.5-05ef4bb', publishedAt: '2026-09-30T17:00:05Z',
    }));
    await expect(activateRelease(root, assets, tag, {
      trustedPublicKey, verifyPublic: async () => {},
    })).resolves.toMatchObject({ releaseId });
  });

  it('rejects a same-ID rebuild that would replace immutable archive bytes', async () => {
    const { root, assets, activateRelease } = await activationFixture();
    await activateRelease(root, assets, tag, { trustedPublicKey, verifyPublic: async () => {} });
    const pointer = readlinkSync(join(root, 'latest'));
    const path = join(assets, 'manifest.linux-x64.json');
    const { signature: _, ...payload } = JSON.parse(readFileSync(path, 'utf8'));
    const artifact = payload.metawork;
    const body = Buffer.alloc(artifact.byteSize);
    writeFileSync(join(assets, artifact.url), body);
    artifact.sha256 = createHash('sha256').update(body).digest('hex');
    writeManifest(assets, 'linux-x64', payload);
    await expect(activateRelease(root, assets, tag, {
      trustedPublicKey, verifyPublic: async () => {},
    })).rejects.toThrow(/immutable/i);
    expect(readlinkSync(join(root, 'latest'))).toBe(pointer);
  });
});
