import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveExecutorTool } from '../../src/utils/executor-tool-path.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), 'tool-path-')); roots.push(root); return root; }
it('keeps managed Pi selected even when missing and a user Pi is executable', () => {
  const root = fixture(); mkdirSync(join(root, 'desktop-tools')); mkdirSync(join(root, 'user'));
  writeFileSync(join(root, 'user/pi'), '#!/bin/sh\n', { mode: 0o755 });
  expect(resolveExecutorTool('pi', { releaseRoot: root, managedPi: '', searchPath: join(root, 'user') }))
    .toBe(join(root, 'desktop-tools/executor/bin/pi'));
});
it('finds an executable in a path with spaces and never substitutes a missing manual choice', () => {
  const root = fixture(); mkdirSync(join(root, 'user tools'));
  const codex = join(root, 'user tools/codex'); writeFileSync(codex, '#!/bin/sh\n', { mode: 0o755 });
  expect(resolveExecutorTool('codex', { releaseRoot: root, searchPath: join(root, 'user tools') })).toBe(codex);
  const manual = join(root, 'missing/codex');
  expect(resolveExecutorTool(manual, { searchPath: join(root, 'user tools') })).toBe(manual);
});
it('probes and launches the same explicit executable for both drivers', async () => {
  for (const Driver of [PiCliDriver, CodexCliDriver]) {
    const command = join(fixture(), 'selected tool');
    const seen: string[] = [];
    const driver = new Driver({ command, probeCommand: async path => { seen.push(path); return { code: 0, stdout: 'tool 1', stderr: '' }; } });
    await driver.probe();
    expect(seen[0]).toBe(command);
    expect(driver.buildLaunch({ runtimeHomePath: '/tmp/isolated', prompt: 'test', cwd: '/tmp' } as never).command).toBe(command);
  }
});
