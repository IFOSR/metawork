import { describe, expect, it } from 'vitest';
import { executionElapsedEndMs } from '../../web/src/execution-duration';

describe('executionElapsedEndMs', () => {
  it('freezes a settled Attempt at its terminal update time', () => {
    expect(executionElapsedEndMs(
      false,
      '2026-08-30T02:53:51.530Z',
      Date.parse('2026-08-30T03:30:00.000Z'),
    )).toBe(Date.parse('2026-08-30T02:53:51.530Z'));
  });

  it('uses the current time only while an Attempt is running', () => {
    const now = Date.parse('2026-08-30T03:30:00.000Z');
    expect(executionElapsedEndMs(true, '2026-08-30T02:53:51.530Z', now)).toBe(now);
  });
});
