import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runResponseOnlyCli } from '../../src/executor/response-only-cli.js';

describe('runResponseOnlyCli', () => {
  it('waits for a timed-out child to exit before deleting its working directory', async () => {
    const processInfoPath = join(tmpdir(), `metaclaw-response-only-child-${process.pid}.json`);
    let childPid: number | null = null;
    try {
      const result = await runResponseOnlyCli({
        command: process.execPath,
        args: ['-e', [
          "const { writeFileSync } = require('node:fs');",
          'writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, cwd: process.cwd() }));',
          "process.on('SIGTERM', () => {});",
          'setInterval(() => {}, 1000);',
        ].join(' '), processInfoPath],
        env: process.env,
        timeoutSeconds: 1,
      });
      const info = JSON.parse(readFileSync(processInfoPath, 'utf8')) as { pid: number; cwd: string };
      childPid = info.pid;

      expect(result.error).toBe('response-only correction timeout');
      expect(existsSync(info.cwd)).toBe(false);
      expect(() => process.kill(info.pid, 0)).toThrow();
    } finally {
      if (childPid !== null) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* child already exited */ }
      }
      rmSync(processInfoPath, { force: true });
    }
  });
});
