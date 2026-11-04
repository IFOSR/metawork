import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIGURATION_REFERENCE_MAX_LENGTH,
  CONFIGURATION_REFERENCE_PATTERN,
  configurationReferenceSlug,
  createConfigurationRevisionId,
  isValidConfigurationRevisionId,
} from '../../src/configuration/revision-id.js';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';

/**
 * A rollback once produced `rollback-0.1.21-local-final-0826-<uuid>`: 69 characters
 * with dots. That id is outside the configuration reference grammar, so the Planner
 * could no longer express the configuration revision it was required to declare —
 * every task-like request failed with "planning budget exhausted".
 */
const DOTTED_RELEASE_ID = '0.1.21-local-final-0826';
const DOTTED_ACTIVATION_ID = `rollback-${DOTTED_RELEASE_ID}-23c74b9f-e70d-4272-8526-484fce429ffa`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('configuration revision identifiers', () => {
  it('rejects the id shape that broke planning', () => {
    expect(isValidConfigurationRevisionId(DOTTED_ACTIVATION_ID)).toBe(false);
    expect(CONFIGURATION_REFERENCE_PATTERN.test(DOTTED_ACTIVATION_ID)).toBe(false);
  });

  it('folds arbitrary labels into the reference grammar', () => {
    // A reference must start with a letter, so a leading digit is prefixed.
    expect(configurationReferenceSlug(DOTTED_RELEASE_ID)).toBe('r-0-1-21-local-final-0826');
    expect(configurationReferenceSlug('Hello  World')).toBe('hello-world');
    expect(configurationReferenceSlug('---')).toBe('unknown');
  });

  it('builds legal ids for every activation kind, even from a dotted release id', () => {
    const cases = [
      createConfigurationRevisionId('rollback', `${DOTTED_RELEASE_ID}-23c74b9f-e70d`),
      createConfigurationRevisionId('update', `${DOTTED_RELEASE_ID}-23c74b9f-e70d`),
      createConfigurationRevisionId('install', DOTTED_RELEASE_ID),
      createConfigurationRevisionId('feishu-manual', '1712345678901'),
    ];
    for (const id of cases) {
      expect(isValidConfigurationRevisionId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(64);
      // The unique suffix survives, so two activations never collide.
      expect(id).toMatch(/23c74b9f|0826|1712345678901/u);
    }
    expect(new Set(cases).size).toBe(cases.length);
  });

  it('fails a draft whose id is outside the grammar, before anything is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-revision-id-'));
    roots.push(root);
    const repository = new FileConfigurationRepository(join(root, 'config'));
    const service = new ConfigurationService({
      repository,
      createRevisionId: () => DOTTED_ACTIVATION_ID,
      probe: async () => ({ ok: true }),
    });
    await service.initialize();

    expect(() => service.createDraft({}, null)).toThrow(/not a valid reference/u);
  });
});

describe('revision ids long enough to exhaust the grammar', () => {
  // `0.1.24-desktoppayload-1903` (25) + '-' + uuid (36) is 62 characters; slugged
  // it is 63, which left a budget of zero and produced a 65-character id. Every
  // Desktop upgrade from that build failed with an unclassified error.
  const releaseId = '0.1.24-desktoppayload-1903';
  const upgrade = (uuid: string) => createConfigurationRevisionId('update', `${releaseId}-${uuid}`);

  it('keeps the id inside the grammar and keeps the unique suffix', () => {
    const uuid = '33fba988-314b-40a6-a9a5-4f1110b25ab0';
    const id = upgrade(uuid);
    expect(isValidConfigurationRevisionId(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(CONFIGURATION_REFERENCE_MAX_LENGTH);
    expect(id.startsWith('update-')).toBe(true);
    expect(id.endsWith(uuid)).toBe(true);
  });

  it('stays unique across every activation kind for that release', () => {
    const uuid = '33fba988-314b-40a6-a9a5-4f1110b25ab0';
    const ids = ['install', 'update', 'rollback'].map(prefix =>
      createConfigurationRevisionId(prefix, `${releaseId}-${uuid}`));
    expect(ids.every(isValidConfigurationRevisionId)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(upgrade(uuid)).not.toBe(upgrade('33fba988-314b-40a6-a9a5-4f1110b25ab1'));
  });

  it('also survives an oversized prefix', () => {
    const id = createConfigurationRevisionId('u'.repeat(80), releaseId);
    expect(isValidConfigurationRevisionId(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(CONFIGURATION_REFERENCE_MAX_LENGTH);
  });
});
