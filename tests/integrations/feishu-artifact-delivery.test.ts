import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuArtifactDeliveryLedger, artifactDeliveryKey } from '../../src/integrations/feishu-artifact-delivery.js';

describe('FeishuArtifactDeliveryLedger reservation state machine', () => {
  it('reserves, then settles, then reports already_delivered on replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    try {
      const ledger = new FeishuArtifactDeliveryLedger(path);
      const key = artifactDeliveryKey({ chatId: 'chat', artifactPath: '/tmp/a.md' });
      expect(ledger.reserve(key, 'a.md')).toBe('reserved');
      expect(ledger.settle(key, 'cloud_doc', { url: 'https://doc/a' })).toBe(true);
      expect(ledger.reserve(key, 'a.md')).toBe('already_delivered');
      const entry = ledger.find(key)!;
      expect(entry.outcome).toBe('cloud_doc');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns in_flight for an un-settled reservation and write_failed when the ledger cannot persist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    try {
      const ledger = new FeishuArtifactDeliveryLedger(path);
      const key = artifactDeliveryKey({ chatId: 'chat', artifactPath: '/tmp/b.md' });
      ledger.reserve(key, 'b.md');
      expect(ledger.reserve(key, 'b.md')).toBe('in_flight');

      // A ledger path whose parent is a regular file cannot be created.
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'x');
      const badLedger = new FeishuArtifactDeliveryLedger(join(blocker, 'nested', 'ledger.jsonl'));
      expect(badLedger.reserve('k', 'n')).toBe('write_failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows re-taking an abandoned pending reservation after the pending TTL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    try {
      const ledger = new FeishuArtifactDeliveryLedger(path, { pendingTtlMs: -1 });
      const key = artifactDeliveryKey({ chatId: 'chat', artifactPath: '/tmp/c.md' });
      expect(ledger.reserve(key, 'c.md')).toBe('reserved');
      // negative pending TTL -> the pending reservation is immediately stale.
      expect(ledger.reserve(key, 'c.md')).toBe('reserved');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
