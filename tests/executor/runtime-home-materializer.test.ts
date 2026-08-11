import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeHomeMaterializer } from '../../src/executor/runtime-home-materializer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('RuntimeHomeMaterializer', () => {
  it('creates an attempt-private home and redacted environment metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-attempt-home-'));
    roots.push(root);
    const materializer = new RuntimeHomeMaterializer(root);

    const result = await materializer.materialize({
      attemptId: 'attempt-123',
      revisionId: 'revision-1',
      agentClassId: 'codex-engineering',
      bindingFingerprint: 'fingerprint',
      environment: { CODEX_HOME: join(root, 'attempt-123', 'home') },
    });

    expect(result.homePath).toBe(join(root, 'attempt-123', 'home'));
    expect(await stat(join(root, 'attempt-123', 'logs'))).toBeTruthy();
    expect(JSON.parse(await readFile(join(root, 'attempt-123', 'environment.json'), 'utf8')))
      .toEqual({
        redacted: true,
        attemptId: 'attempt-123',
        revisionId: 'revision-1',
        agentClassId: 'codex-engineering',
        bindingFingerprint: 'fingerprint',
        environment: { CODEX_HOME: join(root, 'attempt-123', 'home') },
      });
    expect(await readFile(join(root, 'attempt-123', 'receipt.json'), 'utf8')).toContain('"status": "pending"');
  });
});
