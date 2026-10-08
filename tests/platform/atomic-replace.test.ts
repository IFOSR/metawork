import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceFile } from '../../src/platform/atomic-replace.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'mw-replace-')); roots.push(root);
  const source = join(root, 'source'); const target = join(root, 'target');
  await writeFile(source, 'new'); await writeFile(target, 'old');
  return { source, target };
}
async function lock(path: string) {
  const script = `$f=[IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'Read');
    try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const [message] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    expect(message.toString()).toContain('ready');
  } catch (error) { child.kill(); await exited; throw error; }
  return async () => { child.stdin.end('\n'); await exited; };
}

describe('atomic file replacement', () => {
  it('replaces the destination and refuses a missing source without losing the old content', async () => {
    const { source, target } = await files();
    await replaceFile(source, target);
    expect(await readFile(target, 'utf8')).toBe('new');
    await expect(replaceFile(source, target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('new');
  });
  it.skipIf(process.platform !== 'win32')('survives a brief real Windows reader lock', async () => {
    const { source, target } = await files();
    const unlock = await lock(target);
    const replacing = replaceFile(source, target);
    const assertion = expect(replacing).resolves.toBeUndefined();
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(target, 'utf8')).toBe('old');
    } finally { await unlock(); }
    await assertion;
    expect(await readFile(target, 'utf8')).toBe('new');
  }, 15000);
  it.skipIf(process.platform !== 'win32')('fails a persistent lock without deleting either file', async () => {
    const { source, target } = await files();
    const unlock = await lock(target);
    try {
      const started = Date.now();
      await expect(replaceFile(source, target)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES|EBUSY/u) });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await readFile(source, 'utf8')).toBe('new');
      expect(await readFile(target, 'utf8')).toBe('old');
    } finally { await unlock(); }
  }, 15000);
});
