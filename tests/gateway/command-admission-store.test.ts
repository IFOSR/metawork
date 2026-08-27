import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCommandAdmissionStore } from '../../src/gateway/command-admission-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('FileCommandAdmissionStore', () => {
  it('persists pending, submitted and terminal lifecycle transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-command-admission-'));
    roots.push(root);
    const first = new FileCommandAdmissionStore(root);
    const reserved = await first.reserve({
      accountId: 'local-default',
      idempotencyKey: 'idem_1',
      fingerprint: 'fingerprint_1',
      requestId: 'req_1',
      connectionId: 'conn_1',
      scope: { kind: 'conversation', selection: { mode: 'new', workspaceId: 'workspace_repo' } },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      conversationId: null,
      now: '2026-08-19T00:00:00.000Z',
    });
    expect(reserved).toMatchObject({ state: 'pending', conversationId: null });
    await first.assignConversation(
      'local-default',
      'idem_1',
      'fingerprint_1',
      'conv_new_stable',
      '2026-08-19T00:00:00.500Z',
    );
    await first.markSubmitted(
      'local-default',
      'idem_1',
      'fingerprint_1',
      '2026-08-19T00:00:01.000Z',
    );

    const restarted = new FileCommandAdmissionStore(root);
    await expect(restarted.find('local-default', 'idem_1')).resolves.toMatchObject({
      fingerprint: 'fingerprint_1',
      state: 'submitted',
      conversationId: 'conv_new_stable',
    });
    await expect(restarted.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: 'idem_1', state: 'submitted' }),
    ]);

    await restarted.markTerminal(
      'local-default',
      'idem_1',
      'fingerprint_1',
      {
        requestId: 'req_1',
        idempotencyKey: 'idem_1',
        status: 'accepted',
        conversationId: 'conv_new_stable',
        workspaceId: 'workspace_repo',
      },
      '2026-08-19T00:00:02.000Z',
    );
    await expect(restarted.listRecoverable()).resolves.toEqual([]);
    await expect(restarted.find('local-default', 'idem_1')).resolves.toMatchObject({
      receipt: {
        status: 'accepted',
        conversationId: 'conv_new_stable',
        workspaceId: 'workspace_repo',
      },
    });
  });

  it('keeps the first durable Conversation identity under concurrent assignment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-command-admission-'));
    roots.push(root);
    const store = new FileCommandAdmissionStore(root);
    const input = {
      accountId: 'local-default',
      idempotencyKey: 'idem_1',
      fingerprint: 'first',
      requestId: 'req_1',
      connectionId: 'conn_1',
      scope: {
        kind: 'conversation' as const,
        selection: { mode: 'new' as const, workspaceId: 'workspace_repo' },
      },
      command: { kind: 'user_message' as const, text: 'hello', attachments: [] },
      conversationId: null,
      now: '2026-08-19T00:00:00.000Z',
    };
    await store.reserve(input);

    const results = await Promise.all([
      store.assignConversation(
        'local-default',
        'idem_1',
        'first',
        'conv_1',
        '2026-08-19T00:00:01.000Z',
      ),
      store.assignConversation(
        'local-default',
        'idem_1',
        'first',
        'conv_2',
        '2026-08-19T00:00:01.000Z',
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ conversationId: 'conv_1' }),
      expect.objectContaining({ conversationId: 'conv_1' }),
    ]);
  });

  it('does not let a late completion overwrite the first terminal outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-command-admission-'));
    roots.push(root);
    const store = new FileCommandAdmissionStore(root);
    await store.reserve({
      accountId: 'local-default',
      idempotencyKey: 'idem_1',
      fingerprint: 'fingerprint_1',
      requestId: 'req_1',
      connectionId: 'conn_1',
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: 'conv_1' },
      },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      conversationId: 'conv_1',
      now: '2026-08-19T00:00:00.000Z',
    });
    await store.markTerminal(
      'local-default',
      'idem_1',
      'fingerprint_1',
      {
        requestId: 'req_1',
        idempotencyKey: 'idem_1',
        status: 'rejected',
        conversationId: 'conv_1',
        reason: 'command_execution_uncertain',
      },
      '2026-08-19T00:00:01.000Z',
    );

    const late = await store.markTerminal(
      'local-default',
      'idem_1',
      'fingerprint_1',
      {
        requestId: 'req_1',
        idempotencyKey: 'idem_1',
        status: 'accepted',
        conversationId: 'conv_1',
      },
      '2026-08-19T00:00:02.000Z',
    );

    expect(late).toMatchObject({
      state: 'terminal',
      receipt: {
        status: 'rejected',
        reason: 'command_execution_uncertain',
      },
      updatedAt: '2026-08-19T00:00:01.000Z',
    });
  });

  it('keeps admissions isolated by account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-command-admission-'));
    roots.push(root);
    const store = new FileCommandAdmissionStore(root);
    const reserve = (accountId: string, conversationId: string) => store.reserve({
      accountId,
      idempotencyKey: 'same-key',
      fingerprint: `fingerprint:${accountId}`,
      requestId: `request:${accountId}`,
      connectionId: `connection:${accountId}`,
      scope: {
        kind: 'conversation' as const,
        selection: { mode: 'new' as const, workspaceId: 'workspace_repo' },
      },
      command: { kind: 'user_message', text: accountId, attachments: [] },
      conversationId,
      now: '2026-08-19T00:00:00.000Z',
    });

    await reserve('acct-one', 'conv_one');
    await reserve('acct-two', 'conv_two');

    await expect(store.find('acct-one', 'same-key')).resolves.toMatchObject({
      conversationId: 'conv_one',
    });
    await expect(store.find('acct-two', 'same-key')).resolves.toMatchObject({
      conversationId: 'conv_two',
    });
  });
});
