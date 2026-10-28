import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverLaunchSpecification } from '../../src/execution/local-service-discovery.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-discovery-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

describe('launch discovery', () => {
  it('prefers an explicit package script and records the evidence', async () => {
    const root = await project({
      'site/package.json': JSON.stringify({ scripts: { dev: 'vite', start: 'node ./src/server.js' } }),
      'site/server.js': '',
    });
    const found = await discoverLaunchSpecification({ root, targetPath: 'site' });
    expect(found.launch).toEqual({
      serviceId: 'site',
      command: 'npm',
      args: ['run', 'start'],
      directory: 'site',
      evidence: 'package.json scripts.start',
    });
    expect(found.diagnostics).toEqual([]);
  });

  it('uses package.json main before scanning entry files', async () => {
    const root = await project({
      'api/package.json': JSON.stringify({ main: 'lib/boot.mjs' }),
      'api/lib/boot.mjs': '',
      'api/server.js': '',
    });
    const found = await discoverLaunchSpecification({ root, targetPath: 'api' });
    expect(found.launch).toMatchObject({ command: 'node', args: ['lib/boot.mjs'], evidence: 'package.json main' });
  });

  it('runs a delivered Node entry file directly', async () => {
    const root = await project({ 'deliverables/ai-radar-site/server.js': 'console.log(1)' });
    const found = await discoverLaunchSpecification({ root, targetPath: 'deliverables/ai-radar-site' });
    expect(found.launch).toEqual({
      serviceId: 'ai-radar-site',
      command: 'node',
      args: ['server.js'],
      directory: 'deliverables/ai-radar-site',
      evidence: 'entry file server.js',
    });
  });

  it('runs a delivered Python entry file', async () => {
    const root = await project({ 'tools/app/main.py': '' });
    const found = await discoverLaunchSpecification({ root, targetPath: 'tools/app' });
    expect(found.launch).toMatchObject({ command: 'python3', args: ['main.py'] });
  });

  it('reports a diagnosable miss instead of asking the user for a command', async () => {
    const root = await project({ 'notes/README.md': '# nothing runnable' });
    const found = await discoverLaunchSpecification({ root, targetPath: 'notes' });
    expect(found.launch).toBeNull();
    expect(found.diagnostics.join('；')).toContain('无法确定启动方式');
  });

  it('refuses a project directory outside the published root', async () => {
    const root = await project({ 'README.md': '' });
    const found = await discoverLaunchSpecification({ root, targetPath: '../elsewhere' });
    expect(found.launch).toBeNull();
    expect(found.diagnostics.join('；')).toContain('越过');
  });

  it('ignores an unparseable package.json but still finds an entry file', async () => {
    const root = await project({ 'svc/package.json': '{ not json', 'svc/index.js': '' });
    const found = await discoverLaunchSpecification({ root, targetPath: 'svc' });
    expect(found.launch).toMatchObject({ command: 'node', args: ['index.js'] });
    expect(found.diagnostics.join('；')).toContain('无法解析');
  });
});
