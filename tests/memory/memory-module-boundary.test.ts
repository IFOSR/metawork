import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const MEMORY_FILES = [
  'memory-engine',
  'memory-context-service',
  'memory-vault-exporter',
  'context-recaller',
];

describe('memory module architecture boundaries', () => {
  it('keeps the memory domain implementation in src/memory and out of core', () => {
    for (const file of MEMORY_FILES) {
      expect(existsSync(resolve(projectRoot, `src/memory/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
