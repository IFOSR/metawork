import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('canonical runtime entrypoint', () => {
  it('routes every package Server script through the installed app/current release', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['server:start']).toBe(
      'node scripts/run-installed-cli.mjs server start',
    );
    expect(packageJson.scripts['server:stop']).toBe(
      'node scripts/run-installed-cli.mjs server stop',
    );
    expect(packageJson.scripts['server:restart']).toBe(
      'node scripts/run-installed-cli.mjs server restart',
    );
    expect(packageJson.scripts['server:status']).toBe(
      'node scripts/run-installed-cli.mjs server status',
    );
    expect(packageJson.scripts['server:doctor']).toBe(
      'node scripts/run-installed-cli.mjs server doctor',
    );
    expect(packageJson.scripts.start).toBe('node scripts/run-installed-cli.mjs');
  });

  it('executes the active app/current release and preserves the caller workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-installed-cli-'));
    const runtimeEntry = join(root, 'app', 'current', 'dist', 'index.js');
    const source = [
      'process.stdout.write(JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  installRoot: process.env.METAWORK_INSTALL_ROOT,',
      '  releaseId: process.env.METAWORK_RELEASE_ID,',
      '}));',
    ].join('\n');
    try {
      await mkdir(join(root, 'app', 'current', 'dist'), { recursive: true });
      await writeFile(runtimeEntry, source, 'utf8');
      await writeFile(
        join(root, 'app', 'current', 'release-identity.json'),
        JSON.stringify({ releaseId: 'test-release' }),
        'utf8',
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        ['scripts/run-installed-cli.mjs', 'server', 'status'],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            METAWORK_INSTALL_ROOT: root,
            ANYFUSION_INSTALL_ROOT: root,
          },
        },
      );

      expect(JSON.parse(stdout)).toEqual({
        args: ['server', 'status'],
        cwd: repositoryRoot,
        installRoot: root,
        releaseId: 'test-release',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects conflicting canonical and compatibility install roots', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['scripts/run-installed-cli.mjs', 'server', 'status'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          METAWORK_INSTALL_ROOT: '/tmp/metawork-a',
          ANYFUSION_INSTALL_ROOT: '/tmp/metawork-b',
        },
      },
    ).catch(error => error as { stderr: string; code: number });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('conflicts with compatibility variable');
  });
});
