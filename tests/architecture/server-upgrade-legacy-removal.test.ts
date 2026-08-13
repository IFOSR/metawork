import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function* listSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* listSourceFiles(full);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      yield full;
    }
  }
}

// These legacy symbols must not survive in production code. Old physical SQLite
// column names are allowed only inside Storage adapters and are not listed here.
// The legacy configuration reader is the only file allowed to mention the old
// provider.env source because it migrates that source into the new authority.
const LEGACY_SYMBOLS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'BUILTIN_EXECUTOR_VALUES', pattern: /BUILTIN_EXECUTOR_VALUES/ },
  { name: 'worktree_executor_not_canonical', pattern: /worktree_executor_not_canonical/ },
  { name: 'PlannerProcessRunner', pattern: /PlannerProcessRunner/ },
  { name: 'runPlannerTuiProcess', pattern: /runPlannerTuiProcess/ },
  { name: 'PlannerTuiBridge', pattern: /PlannerTuiBridge/ },
  { name: 'fallback to ~/.codex', pattern: /~\/\.codex/ },
  { name: 'fallback to ~/.pi', pattern: /~\/\.pi/ },
  { name: 'provider.env authority', pattern: /provider\.env/ },
];

const ALLOWED_EXCEPTIONS: Record<string, readonly string[]> = {
  'provider.env authority': ['src/configuration/legacy-configuration-reader.ts'],
};

describe('server upgrade legacy removal', () => {
  it('removes legacy executor authority symbols from production code', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(resolve(projectRoot, 'src'))) {
      const relative = file.replace(`${projectRoot}/`, '');
      const content = readFileSync(file, 'utf8');
      for (const { name, pattern } of LEGACY_SYMBOLS) {
        if (pattern.test(content) && !(ALLOWED_EXCEPTIONS[name]?.includes(relative))) {
          violations.push(`${name} -> ${relative}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
