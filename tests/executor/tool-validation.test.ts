import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateCodexCommand } from '../../src/executor/tool-validation.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('validates a selected executable with spaces and rejects missing protocol/permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-validation-')); roots.push(root);
  const path = join(root, 'my codex');
  await writeFile(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; else echo "exec --json"; fi\n', { mode: 0o755 });
  await expect(validateCodexCommand(path)).resolves.toBeUndefined();
  await writeFile(path, '#!/bin/sh\necho "unrelated-tool"\n');
  await expect(validateCodexCommand(path)).rejects.toThrow('检测未通过');
  await chmod(path, 0o600);
  await expect(validateCodexCommand(path)).rejects.toThrow('找不到可执行');
  await expect(validateCodexCommand('./codex')).rejects.toThrow('绝对路径');
});
