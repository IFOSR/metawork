import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { armExitWatchdog } from '../../src/server/exit-watchdog.js';

// Real process-level proof that the watchdog reclaims a process which cannot
// finish (or even handle) its own exit. SIGSTOP makes the victim unable to do
// anything itself, which is the same observable state as a Server stuck inside
// the native part of `process.exit`.
it.skipIf(process.platform === 'win32')('kills a process that can no longer run its own exit', async () => {
  const victim: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      victim.once('spawn', () => resolve());
      victim.once('error', reject);
    });
    process.kill(victim.pid!, 'SIGSTOP');
    const startedAt = Date.now();
    armExitWatchdog({ pid: victim.pid!, timeoutMs: 800 });
    await new Promise<void>(resolve => victim.once('exit', () => resolve()));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    if (victim.exitCode === null && victim.signalCode === null) {
      try { process.kill(victim.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}, 20_000);
