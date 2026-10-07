import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../apps/desktop/node_modules/esbuild/lib/main.js';
import { prepareDevelopmentShell } from '../apps/desktop/packaging/development-shell.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.METAWORK_DESKTOP_DEVELOPMENT_ROOT ?? join(source, '.tmp', 'desktop-development'));
if (root === resolve(process.env.METAWORK_INSTALL_ROOT ?? join(process.env.HOME, '.metawork'))) throw new Error('Development must use an isolated installation');
const productionAssets = process.argv.includes('--production-assets');
const prepareOnly = process.argv.includes('--prepare-only');
const refresh = process.argv.includes('--refresh');
const repairDirectoryJournal = process.argv.includes('--repair-directory-journal');
if (repairDirectoryJournal && !refresh) throw new Error('--repair-directory-journal requires --refresh');
const alreadyInstalled = existsSync(join(root, 'app/current'));
if (alreadyInstalled && !existsSync(join(root, 'desktop-development.json'))) throw new Error('Refusing to attach or refresh an installation without a Desktop development marker');
const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
const releaseId = refresh ? `${version}-desktop-development-${Date.now()}` : alreadyInstalled
  ? JSON.parse(await readFile(join(root, 'app/current/release-identity.json'), 'utf8')).releaseId : `${version}-desktop-development`;
const env = { ...process.env, METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
  METAWORK_CONFIG_HOME: join(root, 'config-home'), ANYFUSION_CONFIG_HOME: join(root, 'config-home'),
  METAWORK_WEB_PORT: '0', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
  METAWORK_DESKTOP_DEVELOPMENT_ROOT: root, METAWORK_DESKTOP_NODE: process.execPath, METAWORK_DESKTOP_RELEASE: releaseId };
delete env.NODE_OPTIONS; delete env.NODE_PATH;
function run(command, args, cwd = source) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
await mkdir(join(source, '.tmp'), { recursive: true });
if (!alreadyInstalled || refresh) {
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'build:offline'], join(source, 'planner/AnyFusion-Pi'));
  const helper = join(source, '.tmp/prepare-desktop-development.mjs');
  await build({ entryPoints: [join(source, 'apps/desktop/packaging/prepare-development.ts')], outfile: helper,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  await run(process.execPath, [helper, root, source, releaseId, alreadyInstalled ? 'update' : 'install',
    ...(repairDirectoryJournal ? ['--repair-directory-journal'] : [])]);
  await writeFile(join(root, 'desktop-development.json'), JSON.stringify({ source, purpose: 'isolated-desktop-development' }), { mode: 0o600 });
}
await run('npm', ['run', 'build:desktop']);
const desktopExecutable = await prepareDevelopmentShell();
if (!prepareOnly) {
  const clientModule = join(source, '.tmp/desktop-service.mjs');
  await build({ entryPoints: [join(source, 'src/client/desktop-service-manager.ts')], outfile: clientModule,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  const { DesktopServiceManager } = await import(clientModule);
  const manager = new DesktopServiceManager({ installRoot: root, nodePath: process.execPath, releaseId, configHome: env.METAWORK_CONFIG_HOME, env });
  const grant = await manager.connect();
  let vite;
  if (!productionAssets) {
    const { createServer } = await import('../web/node_modules/vite/dist/node/index.js');
    env.METAWORK_DESKTOP_UI_ORIGIN = 'http://127.0.0.1:5173';
    vite = await createServer({ root: join(source, 'web'), configFile: false,
      plugins: [(await import('../web/node_modules/@vitejs/plugin-react/dist/index.js')).default()],
      server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: {
        '/api': { target: grant.webOrigin, changeOrigin: true, configure: proxy => proxy.on('proxyReq', request => request.setHeader('origin', grant.webOrigin)) },
        '/ws': { target: grant.webOrigin, ws: true, changeOrigin: true, rewriteWsOrigin: true },
      } } });
    await vite.listen();
  }
  try { await run(desktopExecutable, ['.'], join(source, 'apps/desktop')); }
  finally { await vite?.close(); }
  process.stdout.write(`Desktop exited. Isolated Server continues under ${root}.\n`);
}
