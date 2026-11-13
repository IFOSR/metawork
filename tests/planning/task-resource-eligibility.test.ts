import { describe, expect, it } from 'vitest';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import type { Task } from '../../src/core/types.js';

describe('task resource reference admission', () => {
  it('does not authorize a new Task resource just because its filename occurs in the prompt', () => {
    expect(buildEligibleContextRefKeys({ db: null, sessionId: 'session', targetTask: null,
      userInput: '读取 e2e-exact.md', refs: [{ kind: 'task_resource', locator: 'e2e-exact.md' }],
    })).toEqual([]);
  });

  it('accepts only resources attached to the referenced Task', () => {
    expect(buildEligibleContextRefKeys({ db: null, sessionId: 'session',
      targetTask: { resources: ['/tmp/attached.md'] } as Task, userInput: '读取 outside.md',
      refs: [{ kind: 'task_resource', locator: '/tmp/attached.md' },
        { kind: 'task_resource', locator: 'outside.md' }],
    })).toEqual(['task_resource:/tmp/attached.md']);
  });
});
