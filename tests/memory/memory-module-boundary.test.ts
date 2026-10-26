import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const RETIRED_MEMORY_FILES = [
  'memory-engine',
  'memory-context-service',
  'memory-vault-exporter',
  'context-recaller',
];

describe('memory module architecture boundaries', () => {
  it('keeps the retired local memory chain out of the production tree (ADR-0049)', () => {
    for (const file of RETIRED_MEMORY_FILES) {
      expect(existsSync(resolve(projectRoot, `src/memory/${file}.ts`))).toBe(false);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });

  it('keeps every retired memory dependency out of the Server, Planner and Executor composition', () => {
    const retiredPattern = /memory-engine|context-recaller|memory-context-service|preference-repo|learning-candidate-repo|reflection-event-repo|reflection-engine|promotion-gate|memory-vault-exporter/u;
    const roots = ['src/server', 'src/account', 'src/session', 'src/planning', 'src/execution', 'src/commands', 'src/learning'];
    const files = roots.flatMap(root => {
      if (!existsSync(resolve(projectRoot, root))) return [];
      return readdirSync(resolve(projectRoot, root))
        .filter(name => name.endsWith('.ts'))
        .map(name => `${root}/${name}`);
    });
    for (const file of files) {
      const source = readFileSync(resolve(projectRoot, file), 'utf8');
      expect(source, `${file} must not import a retired memory module`).not.toMatch(retiredPattern);
    }
  });
});

const MEMORY_DOMAIN_FILES = [
  'memory-types',
  'memory-port',
  'memory-scope',
  'memory-runtime-policy',
  'memory-sanitizer',
  'memory-service',
  'memory-flush-scheduler',
  'memory-evidence-service',
  'tdai-memory-adapter',
  'memory-sidecar',
  'memory-sidecar-config',
  'memory-sidecar-command',
  'memory-runtime',
];

/** Pure domain modules must not reach outward for transport or composition. */
const PURE_MEMORY_MODULES = [
  'memory-types',
  'memory-port',
  'memory-scope',
  'memory-runtime-policy',
  'memory-sanitizer',
];

describe('long-term memory module boundaries (ADR-0049)', () => {
  it('keeps every memory domain file inside src/memory', () => {
    for (const file of MEMORY_DOMAIN_FILES) {
      expect(existsSync(resolve(projectRoot, `src/memory/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
      expect(existsSync(resolve(projectRoot, `src/execution/${file}.ts`))).toBe(false);
    }
  });

  it('keeps pure memory modules free of http, database and planner imports', () => {
    for (const file of PURE_MEMORY_MODULES) {
      const source = readFileSync(resolve(projectRoot, `src/memory/${file}.ts`), 'utf8');
      expect(source, `${file} must not import node:http`).not.toMatch(/from 'node:http'/u);
      expect(source, `${file} must not import better-sqlite3`).not.toMatch(/from 'better-sqlite3'/u);
      expect(source, `${file} must not import the planner`).not.toMatch(/from '\.\.\/planning\//u);
      expect(source, `${file} must not import the kernel`).not.toMatch(/from '\.\.\/kernel\//u);
    }
  });

  it('keeps the memory port free of concrete adapter imports', () => {
    const source = readFileSync(resolve(projectRoot, 'src/memory/memory-port.ts'), 'utf8');
    expect(source).not.toMatch(/tdai-memory-adapter/u);
    expect(source).not.toMatch(/from 'node:http'/u);
  });

  it('confines every TDAI protocol path to the adapter and the sidecar config', () => {
    const files = MEMORY_DOMAIN_FILES.map(file => ({
      file,
      source: readFileSync(resolve(projectRoot, `src/memory/${file}.ts`), 'utf8'),
    }));
    for (const { file, source } of files) {
      if (file === 'tdai-memory-adapter') continue;
      expect(source, `${file} must not speak the TDAI v3 paths`).not.toMatch(/'\/v3\//u);
    }
  });

  it('never lets the Planner reach the memory engine directly', () => {
    const files = readdirSync(resolve(projectRoot, 'src/planning'))
      .filter(name => name.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(resolve(projectRoot, 'src/planning', file), 'utf8');
      expect(source, `${file} must not import the memory engine adapter`)
        .not.toMatch(/tdai-memory-adapter|memory-sidecar|memory-runtime/u);
      expect(source, `${file} must not speak the TDAI v3 paths`).not.toMatch(/'\/v3\//u);
    }
  });
});
