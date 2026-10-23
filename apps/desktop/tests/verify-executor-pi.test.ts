import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyExecutorPi } from '../packaging/verify-executor-pi.mjs';

const roots: string[] = [];

async function launcher(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'metawork-executor-pi-'));
  roots.push(root);
  const path = join(root, 'pi');
  await writeFile(path, `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('verifyExecutorPi', () => {
  it('accepts a Pi CLI that supports Runtime-selected Provider and Model arguments', async () => {
    const path = await launcher('printf "Usage: pi [options]\\n  --provider <name>\\n  --model <pattern>\\n"');
    expect(verifyExecutorPi(path)).toContain('Usage: pi');
  });

  it('rejects an AnyFusion Planner launcher that blocks Executor-selected arguments', async () => {
    const path = await launcher('echo "Error: --provider is managed by AnyFusion and cannot be supplied by the Planner client." >&2; exit 1');
    expect(() => verifyExecutorPi(path)).toThrow(/Executor Pi must accept/u);
  });
});
