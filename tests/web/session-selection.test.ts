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
    )).toBe('requested');
  });

  it('does not infer a target from the directory without a client selection', () => {
    expect(selectInitialSessionId(
      [session('recent', '2026-08-28T10:00:00.000Z'), session('active', '2026-08-28T08:00:00.000Z')],
      null,
    )).toBeNull();
  });

  it('does not replace a missing requested session with the newest history', () => {
    expect(selectInitialSessionId(
      [session('old', '2026-08-27T10:00:00.000Z'), session('recent', '2026-08-28T10:00:00.000Z')],
      'deleted',
    )).toBeNull();
  });

  it('does not use substantive history as an implicit target', () => {
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
    )).toBeNull();
  });

  it('returns null instead of creating a session for an empty Workspace', () => {
    expect(selectInitialSessionId([], null)).toBeNull();
  });
});
