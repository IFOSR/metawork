import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ProductionSource {
  path: string;
  source: string;
}

interface AuthorityViolation {
  rule: string;
  path: string;
  line: number;
  excerpt: string;
}

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const productionRoot = resolve(repositoryRoot, 'src');

function productionSources(directory = productionRoot): ProductionSource[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return productionSources(path);
      if (!entry.isFile() || !/\.(?:ts|tsx)$/u.test(entry.name)) return [];
      return [{
        path: relative(repositoryRoot, path),
        source: readFileSync(path, 'utf8'),
      }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function matchingLines(
  file: ProductionSource,
  rule: string,
  pattern: RegExp,
): AuthorityViolation[] {
  return file.source.split(/\r?\n/u).flatMap((line, index) => {
    pattern.lastIndex = 0;
    return pattern.test(line)
      ? [{
          rule,
          path: file.path,
          line: index + 1,
          excerpt: line.trim(),
        }]
      : [];
  });
}

function findAuthorityViolations(): AuthorityViolation[] {
  return productionSources().flatMap(file => {
    const violations = [
      ...matchingLines(
        file,
        'agent-class-name-allowlist',
        /\[\s*['"]codex-cli['"]\s*,\s*['"]pi-agent['"]\s*\]\s*\.includes\s*\(/u,
      ),
      ...matchingLines(
        file,
        'worktree-executor-name-authority',
        /\bworktree_executor_not_canonical\b/u,
      ),
    ];

    if (file.path !== 'src/installation/paths.ts') {
      violations.push(...matchingLines(
        file,
        'legacy-product-path-api',
        /\bresolveAnyFusionPaths\b/u,
      ));
    }

    if (/^src\/(?:commands|cli|tui|tui-bridge)\//u.test(file.path)) {
      violations.push(...matchingLines(
        file,
        'command-or-ui-direct-agent-class-write',
        /\b(?:agentClassRepo|agentClasses)\s*\.\s*(?:upsert|insert|create|update|delete)\s*\(/u,
      ));
    }

    if (file.path !== 'src/configuration/legacy-configuration-reader.ts') {
      violations.push(...matchingLines(
        file,
        'provider-env-runtime-authority',
        /\b(?:readFile|readFileSync|buildEnvFromFile)\s*\([^;\n]*provider\.env/u,
      ));
    }

    if (/^src\/(?:executor|execution)\//u.test(file.path)) {
      violations.push(...matchingLines(
        file,
        'legacy-harness-model-settings-fallback',
        /\b(?:readFile|readFileSync)\s*\([^;\n]*(?:config\.toml|models\.json|settings\.json)/u,
      ));
    }

    return violations;
  }).sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.rule.localeCompare(right.rule)
  );
}

function formatViolations(violations: AuthorityViolation[]): string {
  return [
    'Legacy configuration authorities remain in production source:',
    ...violations.map(violation =>
      `[${violation.rule}] ${violation.path}:${violation.line} ${violation.excerpt}`
    ),
  ].join('\n');
}

describe('configuration authority cutover', () => {
  it('removes legacy runtime and command authorities from production source', () => {
    const violations = findAuthorityViolations();

    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
