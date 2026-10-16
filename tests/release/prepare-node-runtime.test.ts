import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareNodeRuntime } from '../../scripts/prepare-node-runtime.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-node-package-'));
  roots.push(root);
  const source = join(root, 'source');
  for (const file of ['bin/node', 'LICENSE', 'README.md', 'bin/npm', 'include/node.h',
    'lib/node_modules/@openai/codex/native', 'lib/node_modules/@larksuite/cli/cli.js', 'share/unrelated']) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), file, { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  return { source, output: join(root, 'output') };
}

describe('Desktop minimal Node runtime', () => {
  it('preserves the executable and notices while excluding polluted distribution content', async () => {
    const { source, output } = await fixture();
    await prepareNodeRuntime(source, output);
    expect((await readdir(output)).sort()).toEqual(['LICENSE', 'README.md', 'bin']);
    expect(await readdir(join(output, 'bin'))).toEqual(['node']);
    expect(await readFile(join(output, 'bin/node'))).toEqual(await readFile(join(source, 'bin/node')));
    expect((await stat(join(output, 'bin/node'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('LICENSE');
    expect(await readFile(join(source, 'lib/node_modules/@openai/codex/native'), 'utf8'))
      .toBe('lib/node_modules/@openai/codex/native');
  });

  it('refuses existing output without deleting its contents', async () => {
    const { source, output } = await fixture();
    await mkdir(output);
    await writeFile(join(output, 'keep'), 'existing data');
    await expect(prepareNodeRuntime(source, output)).rejects.toThrow();
    expect(await readFile(join(output, 'keep'), 'utf8')).toBe('existing data');
  });

  it('requires the Node license before creating output', async () => {
    const { source, output } = await fixture();
    await rm(join(source, 'LICENSE'));
    await expect(prepareNodeRuntime(source, output)).rejects.toThrow();
    await expect(stat(output)).rejects.toThrow();
  });

  it('refuses overlapping input and output', async () => {
    const { source } = await fixture();
    await expect(prepareNodeRuntime(source, join(source, 'nested'))).rejects.toThrow('separate trees');
    expect(await readFile(join(source, 'bin/node'), 'utf8')).toBe('bin/node');
  });
});
