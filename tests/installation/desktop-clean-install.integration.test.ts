import { generateKeyPairSync, sign } from 'node:crypto';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runDesktopInstall } from '../../src/desktop-install-cli.js';
import { desktopInventory } from '../../src/installation/desktop-release.js';
import { canonicalizeReleaseManifestPayload } from '../../src/installation/release-manifest.js';
import { loadInternalSettingsAssistantConfig } from '../../src/configuration/internal-settings-assistant-config.js';
import { SourceNativeInstaller } from '../../src/installation/source-native-installer.js';
import { resolveMetaWorkPaths } from '../../src/installation/paths.js';
import { createProductionSecretStore } from '../../src/configuration/production-secret-store.js';
import { desktopSupportRoot } from '../../src/installation/desktop-support.js';
import Database from 'better-sqlite3';

describe.skipIf(process.platform === 'win32')('clean Desktop installer transaction', () => {
  it.each(['clean', 'native-reuse', 'native-upgrade'])('handles %s with signed payloads and preserves existing account data', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-desktop-clean-'));
    const resources = join(root, 'resources');
    const installRoot = join(root, 'installation');
    const keys = generateKeyPairSync('ed25519');
    const signed = (value: object) => ({ ...value, signature: { algorithm: 'ed25519', keyId: 'test',
      value: sign(null, Buffer.from(canonicalizeReleaseManifestPayload(value)), keys.privateKey).toString('base64') } });
    try {
      vi.stubEnv('METAWORK_SECRET_STORE', 'file'); vi.stubEnv('ANYFUSION_SECRET_STORE', 'file');
      vi.stubEnv('METAWORK_DESKTOP_INTERNAL', '1');
      vi.stubEnv('METAWORK_INTERNAL_LLM_SOURCE_ROOT', join(root, 'missing-developer-home'));
      const payload = join(resources, 'payload');
      const contents: Record<string, string> = {
        'metawork/package.json': '{"name":"metawork","version":"0.1.5"}',
        'planner/package.json': '{"name":"planner"}',
        'metawork/dist/index.js': '// runtime fixture',
        'metawork/dist/desktop-install-cli.js': '// fixture',
        'metawork/dist/desktop-update-cli.js': '// fixture',
        'metawork/web/dist/index.html': '<html>Web fixture</html>',
        'planner/packages/coding-agent/dist/cli.js': '// planner fixture',
        'metawork/desktop-tools/node/bin/node': '#!/bin/sh\nexit 0\n',
        'metawork/desktop-tools/git/bin/git': '#!/bin/sh\nexit 0\n',
        'metawork/desktop-tools/executor/bin/pi': '#!/bin/sh\nexit 0\n',
      };
      for (const [name, body] of Object.entries(contents)) {
        const file = join(payload, name); await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body, { mode: 0o755 });
      }
      for (const name of ['metawork', 'planner']) await mkdir(join(payload, name, 'node_modules'));
      const artifact = { source: 'https://example.test/source', revision: 'a'.repeat(40),
        url: 'https://example.test/archive.tar.gz', byteSize: 1, sha256: 'b'.repeat(64) };
      const runtime = signed({ manifestSchemaVersion: 1, releaseId: '0.1.5-build-aaaaaaa', channel: 'stable',
        publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
        minimumInstallerVersion: '1.2.0', minimumNodeVersion: '22.19.0', platform: 'darwin', arch: process.arch,
        metawork: artifact, planner: artifact, previousCompatibleRelease: null,
        compatibility: { configurationSchema: 2, plannerHostProtocol: 2, planningPlanSchema: 8,
          planningPlanSchemaHash: 'schema', workGraphSchema: 7, kernelDecisionSchema: 6, databaseSchema: 47 },
      });
      await writeFile(join(resources, 'trusted-release-keys.json'), JSON.stringify({
        test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }));
      await writeFile(join(resources, 'desktop-release.json'), JSON.stringify(signed({
        schemaVersion: 1, releaseId: '0.1.5-build-aaaaaaa', desktopVersion: '0.1.5', electronVersion: '44.5.1',
        platform: 'darwin', arch: process.arch, sourceCommit: 'a'.repeat(40), development: true,
        nodeVersion: '22.23.3', nodeAbi: '127', gatewayProtocolVersion: 2, capabilities: ['desktop-session-v1'],
        runtimeManifest: runtime, files: await desktopInventory(payload),
      })));
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const database = join(installRoot, 'accounts/local-default/data/anyfusion.db');
      const config = join(installRoot, 'accounts/local-default/config/active');
      const paths = resolveMetaWorkPaths(undefined, installRoot);
      let previousConfiguration: string | undefined;
      let previousCredentials: string | undefined;
      let previousDatabase: Buffer | undefined;
      if (scenario !== 'clean') {
        const nativeSource = join(root, 'native-source');
        await cp(join(payload, 'metawork'), nativeSource, { recursive: true });
        await rm(join(nativeSource, 'desktop-tools'), { recursive: true });
        await new SourceNativeInstaller({ paths,
          secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }),
          detectCommand: async command => command === 'pi', installLaunchers: false,
        }).install({ releaseId: scenario === 'native-reuse' ? '0.1.5-build-aaaaaaa' : '1.2.0-preview.3-build-e33e516-1789389295',
          sourceRoot: nativeSource, plannerRoot: join(payload, 'planner'), executorPreset: 'desktop-pi',
          provider: { baseUrl: 'https://existing-provider.example.test/v1', apiKey: 'existing-user-key', modelId: 'existing-model',
            region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' },
        });
        const db = new Database(database);
        try { db.exec("CREATE TABLE adoption_test (value TEXT); INSERT INTO adoption_test VALUES ('existing work');"); }
        finally { db.close(); }
        previousConfiguration = await readlink(config);
        previousCredentials = await readFile(paths.credentials, 'utf8');
        previousDatabase = await readFile(database);
      }
      await runDesktopInstall([scenario === 'clean' ? 'install' : scenario === 'native-reuse' ? 'prepare-desktop' : 'update',
        resources, installRoot, '0.1.5'], Readable.from(scenario === 'clean' ? [
        JSON.stringify({ baseUrl: 'https://provider.example.test/v1', apiKey: 'test-user-key', modelId: 'test-model' }),
      ] : []));
      expect(JSON.parse(await readFile(join(installRoot, 'app/current/release-identity.json'), 'utf8')))
        .toMatchObject({ releaseId: '0.1.5-build-aaaaaaa' });
      await expect(access(join(installRoot, 'accounts/local-default/data/anyfusion.db'))).resolves.toBeUndefined();
      await expect(access(join(installRoot, 'internal/llm-credentials.json'))).rejects.toThrow();
      await expect(loadInternalSettingsAssistantConfig({ installRoot })).resolves.toMatchObject({ enabled: false });
      if (scenario !== 'clean') {
        expect(await readlink(config)).toBe(previousConfiguration);
        expect(await readFile(paths.credentials, 'utf8')).toBe(previousCredentials);
        const db = new Database(database, { readonly: true });
        try { expect(db.prepare('SELECT value FROM adoption_test').get()).toEqual({ value: 'existing work' }); }
        finally { db.close(); }
      }
      if (scenario === 'native-reuse') {
        expect(await readFile(database)).toEqual(previousDatabase);
        await expect(access(join(installRoot, 'app/current/desktop-tools'))).rejects.toThrow();
        await expect(access(join(desktopSupportRoot(installRoot, '0.1.5-build-aaaaaaa'), 'desktop-tools/node/bin/node')))
          .resolves.toBeUndefined();
      }
    } finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      async function writable(path: string): Promise<void> {
        const entry = await lstat(path); if (entry.isSymbolicLink()) return;
        await chmod(path, 0o700);
        if (entry.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
      }
      await writable(root); await rm(root, { recursive: true, force: true });
    }
  });
});
