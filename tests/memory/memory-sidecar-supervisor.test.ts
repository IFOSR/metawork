import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  isTcpEndpointListening,
  memorySidecarSupervisor,
} from '../../src/memory/memory-sidecar-supervisor.js';
import { MemorySidecar } from '../../src/memory/memory-sidecar.js';

/** An engine that reports its own pid and then idles. */
const idleEngine = {
  command: process.execPath,
  args: ['-e', 'process.stdout.write(`pid:${process.pid}\\n`); setInterval(() => undefined, 1000);'],
};

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('memory sidecar supervisor', () => {
  it('kills the engine when its stdin closes, so no engine outlives MetaWork', async () => {
    const supervisor = memorySidecarSupervisor(idleEngine);
    const child = spawn(supervisor.command, supervisor.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const enginePid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no engine pid: ${output}`)), 10_000);
      child.stdout?.on('data', chunk => {
        output += String(chunk);
        const match = /pid:(\d+)/u.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', reject);
    });
    expect(pidAlive(enginePid)).toBe(true);

    // The Server dying closes the write end; no signal is involved.
    child.stdin?.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => resolve(), 8_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(pidAlive(enginePid)).toBe(false);
  }, 30_000);

  it('refuses to attach to an engine the Server did not start', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await isTcpEndpointListening('127.0.0.1', port)).toBe(true);
      const messages: string[] = [];
      const sidecar = new MemorySidecar({
        command: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000);'],
        env: {},
        healthUrl: `http://127.0.0.1:${port}/health`,
        preflight: { host: '127.0.0.1', port },
        logger: message => messages.push(message),
      });
      const status = await sidecar.start();
      expect(status.running).toBe(false);
      // Health is never taken from the foreign process, even though it listens.
      expect(await sidecar.probe()).toMatchObject({
        ready: false,
        detail: `memory_engine_port_in_use: 127.0.0.1:${port}`,
      });
      expect(messages.join('\n')).toContain('already in use by a process MetaWork does not own');
      await sidecar.stop();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);
});
