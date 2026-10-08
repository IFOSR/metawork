import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { resolveHostToolPath } from '../../src/utils/host-tool-path.js';
import { safeHostEnvironment } from '../../src/executor/harness-driver.js';

it('finds a shell-installed CLI with Finder PATH and uses the same path for execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tool-path-'));
  try {
    const bin = join(home, 'custom-node/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nprintf "fixture-codex:%s" "$1"\n', { mode: 0o755 });
    const PATH = await resolveHostToolPath({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', NODE_OPTIONS: 'secret' }, {
      platform: 'darwin', home, readShellPath: async (_shell, env) => {
        expect(env.NODE_OPTIONS).toBeUndefined();
        return `shell greeting\n__METAWORK_TOOL_PATH__${bin}:/usr/bin\0trailing output`;
      },
    });
    const env = safeHostEnvironment({ PATH });
    const exec = promisify(execFile);
    expect((await exec('codex', ['--version'], { env })).stdout).toBe('fixture-codex:--version');
    expect((await exec('codex', ['exec'], { env })).stdout).toBe('fixture-codex:exec');
    expect(PATH?.startsWith('/usr/bin:/bin:')).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('falls back on shell failure without adding cwd or relative paths', async () => {
  const PATH = await resolveHostToolPath({ PATH: '/bundled/bin:.:relative::/usr/bin' }, {
    platform: 'darwin', home: '/Users/test', readShellPath: async () => { throw new Error('timeout'); },
  });
  expect(PATH?.split(':')).toContain('/Users/test/.local/share/pi-node/current/bin');
  expect(PATH?.split(':')).not.toContain('.');
  expect(PATH?.split(':')).not.toContain('');
  expect(PATH?.startsWith('/bundled/bin:')).toBe(true);
});

it('does not invoke a login shell or change PATH on other platforms', async () => {
  expect(await resolveHostToolPath({ PATH: 'C:\\tools' }, { platform: 'win32',
    readShellPath: async () => { throw new Error('must not run'); } })).toBe('C:\\tools');
});
