import { describe, expect, it } from 'vitest';
import type { WebSessionMetadata } from '../../web/src/api/session-types';
import { selectInitialSessionId } from '../../web/src/session-selection';

function session(
  id: string,
  updatedAt: string,
  overrides: Partial<WebSessionMetadata> = {},
): WebSessionMetadata {
  return {
    id,
    workspaceId: 'workspace-1',
    title: id,
    createdAt: updatedAt,
    updatedAt,
    active: false,
    archived: false,
    workspace: null,
    ...overrides,
  };
}

describe('selectInitialSessionId', () => {
  it('opens an explicitly requested session when it is available', () => {
    expect(selectInitialSessionId(
      [session('recent', '2026-08-28T10:00:00.000Z'), session('requested', '2026-08-28T09:00:00.000Z')],
      'requested',
      null,
    )).toBe('requested');
  });

  it('keeps the server active session before falling back to recency', () => {
    expect(selectInitialSessionId(
      [session('recent', '2026-08-28T10:00:00.000Z'), session('active', '2026-08-28T08:00:00.000Z')],
      null,
      'active',
    )).toBe('active');
  });

  it('opens the most recently updated history when no session is active', () => {
    expect(selectInitialSessionId(
      [session('old', '2026-08-27T10:00:00.000Z'), session('recent', '2026-08-28T10:00:00.000Z')],
      null,
      null,
    )).toBe('recent');
  });

  it('skips newer empty startup placeholders when substantive history exists', () => {
    expect(selectInitialSessionId(
      [
        session('recent-empty', '2026-08-28T10:00:00.000Z', {
          title: 'New conversation',
        }),
        session('recent-real', '2026-08-27T10:00:00.000Z', {
          title: '分析 Workspace',
          preview: '分析 Workspace',
        }),
      ],
      null,
      null,
    )).toBe('recent-real');
  });

  it('returns null instead of creating a session for an empty Workspace', () => {
    expect(selectInitialSessionId([], null, null)).toBeNull();
  });
});
