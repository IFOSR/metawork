import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivationJournalStore } from '../../src/configuration/activation-journal.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ActivationJournalStore', () => {
  it('persists prepared and committed activation phases atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-activation-journal-'));
    roots.push(root);
    const path = join(root, 'activation-journal.json');
    const journal = new ActivationJournalStore(path);

    await journal.writePrepared({
      transactionId: 'activation-1',
      previousRevisionId: 'revision-1',
      nextRevisionId: 'revision-2',
    });
    expect(await journal.read()).toEqual({
      schemaVersion: 1,
      phase: 'prepared',
      transactionId: 'activation-1',
      previousRevisionId: 'revision-1',
      nextRevisionId: 'revision-2',
    });

    await journal.writeCommitted({
      transactionId: 'activation-1',
      previousRevisionId: 'revision-1',
      nextRevisionId: 'revision-2',
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      phase: 'committed',
      nextRevisionId: 'revision-2',
    });
  });
});
