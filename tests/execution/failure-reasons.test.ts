import { describe, expect, it } from 'vitest';
import { describeAttemptFailure } from '../../src/execution/failure-reasons.js';

describe('describeAttemptFailure', () => {
  it('maps the 2026-09-03 incident failure shapes to actionable hints', () => {
    expect(describeAttemptFailure({
      errorDetail: 'Cannot copy a socket file: cp returned EINVAL (cannot copy a socket file: /x/.agent-browser/default.sock)',
    })).toContain('socket');

    expect(describeAttemptFailure({
      errorDetail: 'workspace checkpoint rejects symlink: .venv/bin/python',
    })).toContain('符号链接');

    expect(describeAttemptFailure({
      errorDetail: "ENOTEMPTY: directory not empty, rmdir '/x/plain-import/.git/objects'",
    })).toContain('重试');

    expect(describeAttemptFailure({
      errorDetail: 'refusing to import workspace source into itself: /x/workspace-store',
    })).toContain('工作区');

    expect(describeAttemptFailure({
      failureCode: 'attempt_timeout',
      errorDetail: null,
    })).toContain('超时');
  });

  it('returns null for unknown failures', () => {
    expect(describeAttemptFailure({ failureCode: 'other', errorDetail: 'mystery' })).toBeNull();
  });
});
