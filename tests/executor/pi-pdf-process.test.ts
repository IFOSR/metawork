import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SpawnLocalCliChildProcessRunner } from '../../src/executor/local-cli-executor-adapter.js';

describe.skipIf(process.platform === 'win32')('Pi PDF worker lifecycle', () => {
  it('includes the PDF worker in the attempt process group during authorized cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-pdf-lifecycle-'));
    const runner = new SpawnLocalCliChildProcessRunner({ terminationGraceMs: 100 });
    try {
      await mkdir(join(root, 'python/bin'), { recursive: true });
      await copyFile('integrations/pi-pdf/process.mjs', join(root, 'process.mjs'));
      // A blocked parser fixture: live process, no further work progress.
      const worker = join(root, 'python/bin/python3');
      await writeFile(worker, `#!${process.execPath}\nconst {writeFileSync} = require('node:fs');\nprocess.on('SIGTERM',()=>{});\nwriteFileSync(${JSON.stringify(join(root, 'pid'))},String(process.pid));\nprocess.stderr.write('PDF_PROGRESS:page 1 started\\n');\nsetInterval(()=>{},1000);\n`);
      await chmod(worker, 0o700);
      await writeFile(join(root, 'parent.mjs'), `import {runPdfProcess} from './process.mjs';await runPdfProcess(['-c','fixture']);`);
      const pending = runner.run({ attemptId: 'pdf-cancel', command: process.execPath, args: [join(root, 'parent.mjs')],
        cwd: root, environment: {}, idleTimeoutMs: 50 });
      await vi.waitFor(async () => expect(await readFile(join(root, 'pid'), 'utf8')).toMatch(/^\d+$/), { timeout: 5000 });
      const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
      process.kill(pid, 0);
      runner.abort('pdf-cancel');
      const result = await pending;
      expect(result.diagnostics?.terminationSource).toBe('abort');
      expect(result.diagnostics?.sigkillSentAt).toBeTruthy();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally { runner.abort(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an already cancelled operation before launching any worker', async () => {
    const { runPdfProcess } = await import(pathToFileURL(join(process.cwd(), 'integrations/pi-pdf/process.mjs')).href);
    await expect(runPdfProcess([], { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  });
});
