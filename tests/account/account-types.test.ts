import { describe, expect, it } from 'vitest';
import {
  isValidAccountId,
  LOCAL_DEFAULT_ACCOUNT_ID,
  parseAccountId,
} from '../../src/account/account-id.js';
import type {
  Account,
  AccountId,
  Principal,
  PrincipalKind,
} from '../../src/account/types.js';
import {
  isValidConversationId,
  type ConversationBinding,
  type ConversationId,
  type ConversationSelection,
} from '../../src/session/conversation-types.js';

describe('account identity contracts', () => {
  it('reserves the local-default account id', () => {
    expect(LOCAL_DEFAULT_ACCOUNT_ID).toBe('local-default');
    expect(isValidAccountId(LOCAL_DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(parseAccountId(LOCAL_DEFAULT_ACCOUNT_ID)).toBe('local-default');
  });

  it('validates bounded account ids', () => {
    expect(isValidAccountId('acct_abc123')).toBe(true);
    expect(isValidAccountId('')).toBe(false);
    expect(isValidAccountId('a'.repeat(65))).toBe(false);
    expect(parseAccountId('')).toBeNull();
  });

  it('rejects path traversal and unsafe account ids', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', '/etc', 'A-B', 'ab c', '-lead', '_lead']) {
      expect(isValidAccountId(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });

  it('validates bounded conversation ids', () => {
    expect(isValidConversationId('conv_123')).toBe(true);
    expect(isValidConversationId('')).toBe(false);
    expect(isValidConversationId('c'.repeat(129))).toBe(false);
    expect(isValidConversationId('../evil')).toBe(false);
    expect(isValidConversationId('a/b')).toBe(false);
  });

  it('exposes the four principal kinds', () => {
    const kinds: readonly PrincipalKind[] = ['local', 'web', 'feishu', 'app'];
    expect(kinds).toHaveLength(4);
  });

  it('keeps principal, account and conversation as distinct identities', () => {
    const principal: Principal = { kind: 'local', id: 'local-installation' };
    const account: Account = { accountId: 'local-default' as AccountId };
    const selection: ConversationSelection = { mode: 'attach', conversationId: 'conv_1' as ConversationId };
    const binding: ConversationBinding = { platform: 'feishu', channelId: 'chat_1' };

    expect(principal).not.toHaveProperty('accountId');
    expect(account).not.toHaveProperty('kind');
    expect(selection).toHaveProperty('conversationId');
    expect(binding).toHaveProperty('platform');
  });
});
