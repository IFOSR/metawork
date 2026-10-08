import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { build } from 'esbuild';

it('keeps business Runtime implementations out of the Electron entry and Web bridge', async () => {
  for (const dir of ['main', 'preload']) {
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = await readFile(join(dir, file), 'utf8');
      const imports = [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)/gu)].map(match => match[1]);
      for (const target of imports) expect(target).not.toMatch(/src\/(?:storage|account|kernel|execution|executor|planning|server\/server-composition)\//u);
    }
  }
  const preload = await readFile('preload/preload.ts', 'utf8');
  expect(preload).not.toContain("exposeInMainWorld('ipcRenderer'");
  const web = await readFile('../../web/src/platform/services.ts', 'utf8');
  expect(web).not.toMatch(/from ['"](?:electron|node:)/u);
  const graph = await build({ entryPoints: ['main/main.ts'], bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', external: ['electron', 'original-fs'] });
  for (const path of Object.keys(graph.metafile!.inputs)) {
    expect(path).not.toMatch(/src\/(?:storage|account|kernel|execution|executor|planning)\//u);
    expect(path).not.toContain('server-composition');
  }
});

it('sets the MetaWork identity and keeps native menus on one system locale', async () => {
  const main = await readFile('main/main.ts', 'utf8');
  expect(main).toContain("app.setName('MetaWork');");
  expect(main).toContain('const chinese = /^zh(?:-|$)/iu.test(app.getLocale());');
  expect(main).toContain("{ label: labels.application, submenu: [");
  expect(main).toContain("{ label: labels.file, submenu: [");
  expect(main).toContain("{ label: labels.edit, submenu: [");
  expect(main).toContain("{ label: labels.view, submenu: [");
  expect(main).toContain("{ label: labels.window, submenu: [");
});
