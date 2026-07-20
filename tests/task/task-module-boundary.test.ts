import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const taskDomainFiles = [
  'task-engine',
  'task-runtime-service',
  'task-execution-planner',
  'task-relevance-ranker',
  'task-embedding-service',
  'hybrid-task-retriever',
];

describe('task module architecture boundaries', () => {
  it('keeps task domain implementations in src/task and out of core', () => {
    for (const file of taskDomainFiles) {
      expect(existsSync(resolve(projectRoot, `src/task/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
