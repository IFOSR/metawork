import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCompleteRuntime,
  checkRuntimeArtifacts,
  REQUIRED_RUNTIME_ARTIFACTS,
} from '../../src/installation/runtime-artifacts.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metawork-runtime-artifacts-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime artifact preflight', () => {
  it('reports every missing generated artifact', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, REQUIRED_RUNTIME_ARTIFACTS[0]), '');

    const check = checkRuntimeArtifacts(root);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([REQUIRED_RUNTIME_ARTIFACTS[1]]);
    expect(() => assertCompleteRuntime(root)).toThrow(/runtime is incomplete/);
  });

  it('passes when the build produced every artifact', () => {
    const root = tempRoot();
    for (const relativePath of REQUIRED_RUNTIME_ARTIFACTS) {
      const target = join(root, relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, '');
    }
    expect(checkRuntimeArtifacts(root).ok).toBe(true);
    expect(() => assertCompleteRuntime(root)).not.toThrow();
  });
});
