import { describe, expect, it } from 'vitest';
import { isClientViewEvent } from '../../src/gateway/view-events.js';
import type {
  ArtifactPublished,
  ConfigurationChanged,
  NoticeRaised,
  TaskStateChanged,
} from '../../src/gateway/view-events.js';

function base() {
  return {
    schemaVersion: 1,
    id: 'event-1',
    occurredAt: '2026-08-13T00:00:00.000Z',
    sessionId: null,
  };
}

describe('ClientViewEvent', () => {
  it('recognizes a structured task state change', () => {
    const event: TaskStateChanged = {
      ...base(),
      type: 'task_state_changed',
      taskId: 'task-1',
      from: 'ready',
      to: 'running',
    };

    expect(isClientViewEvent(event)).toBe(true);
    expect(event.type).toBe('task_state_changed');
  });

  it('recognizes a configuration change without a previous revision', () => {
    const event: ConfigurationChanged = {
      ...base(),
      type: 'configuration_changed',
      fromRevisionId: null,
      toRevisionId: 'revision-2',
    };

    expect(isClientViewEvent(event)).toBe(true);
  });

  it('recognizes an artifact publication', () => {
    const event: ArtifactPublished = {
      ...base(),
      type: 'artifact_published',
      taskId: 'task-1',
      publicationId: 'publication-1',
      artifactCount: 3,
    };

    expect(isClientViewEvent(event)).toBe(true);
  });

  it('recognizes a notice with severity', () => {
    const event: NoticeRaised = {
      ...base(),
      type: 'notice_raised',
      severity: 'warning',
      text: 'recovery blocked',
    };

    expect(isClientViewEvent(event)).toBe(true);
    expect(event.severity).toBe('warning');
  });

  it('rejects non-events and malformed payloads', () => {
    expect(isClientViewEvent(null)).toBe(false);
    expect(isClientViewEvent('text')).toBe(false);
    expect(isClientViewEvent({ type: 'task_state_changed' })).toBe(false);
    expect(isClientViewEvent({ ...base(), type: 'unknown' })).toBe(false);
  });
});
