import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { configurationContentHash } from '../../src/configuration/configuration-service.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { SPAN_ROUTING_MODEL, SPAN_ROUTING_SECRET_REFERENCE } from '../../src/configuration/schema.js';

describe('retired Span revision startup', () => {
  it.each([true, false])('loads an immutable retired-model revision (enabled=%s) without rewriting it', async enabled => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-retired-span-'));
    try {
      const repository = new FileConfigurationRepository(root);
      await repository.initialize();
      const config = buildStagedLegacyConfiguration({ testMode: true }).snapshot.config;
      const persistedConfig = {
        ...config,
        routing: {
          span: {
            enabled,
            model: 'respan/span-01-lite',
            apiKeyRef: SPAN_ROUTING_SECRET_REFERENCE,
            timeoutMs: 8_000,
          },
        },
      };
      const contentHash = configurationContentHash(persistedConfig);
      const source = dump(persistedConfig, { noRefs: true, sortKeys: true });
      await repository.writeRevision({
        revisionId: 'revision-retired-span',
        contentHash,
        files: { 'config.yaml': source },
      });
      await repository.activateRevision('revision-retired-span', null);
      const snapshot = await repository.getActiveSnapshot();
      expect(snapshot.config.routing?.span?.model).toBe(SPAN_ROUTING_MODEL);

      const staged = buildStagedLegacyConfiguration({ migratedSnapshot: snapshot, testMode: false });
      expect(staged.snapshot.contentHash).toBe(contentHash);
      expect(staged.snapshot.revisionId).toBe(snapshot.revisionId);
      expect(staged.kernel.spanRouting?.model).toBe(SPAN_ROUTING_MODEL);
      expect(await readFile(join(root, 'active', 'config.yaml'), 'utf8')).toBe(source);

      // The legacy model exception must not mask any other changed content.
      for (const mutate of [
        (value: typeof snapshot.config) => { value.routing!.span!.timeoutMs = 7_000; },
        (value: typeof snapshot.config) => { value.routing!.span!.enabled = !enabled; },
        (value: typeof snapshot.config) => { value.models['test-model']!.modelId = 'changed'; },
        (value: typeof snapshot.config) => { value.runtimePolicy.maxConcurrentTasks = 3; },
      ]) {
        const changed = structuredClone(snapshot);
        mutate(changed.config);
        expect(() => buildStagedLegacyConfiguration({ migratedSnapshot: changed }))
          .toThrow(/content hash mismatch/u);
      }
      expect(() => buildStagedLegacyConfiguration({
        migratedSnapshot: { ...snapshot, contentHash: 'stale-content-hash' },
      })).toThrow(/content hash mismatch/u);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
}
