// Development-shell regression only: no paid model calls or packaged-install claim.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This regression requires native macOS');
const source = fileURLToPath(new URL('../', import.meta.url));
// Keep Unix socket paths short, and never attach to the user's normal installation.
const root = await mkdtemp('/tmp/mwdr-');
const evidence = resolve(source, '.tmp/windows-desktop-validation', `macos-${process.arch}-${Date.now()}`);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:METAWORK_|METACLAW_|ANYFUSION_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/u.test(name)));
Object.assign(env, {
  METAWORK_DESKTOP_DEVELOPMENT_ROOT: root,
  METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
  METAWORK_CONFIG_HOME: join(root, 'config-home'), ANYFUSION_CONFIG_HOME: join(root, 'config-home'),
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: root,
  METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file',
  METAWORK_WEB_PORT: '0', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
});
await mkdir(join(root, 'internal'), { recursive: true, mode: 0o700 });
await writeFile(join(root, 'internal/llm.json'), JSON.stringify({
  provider: 'deepseek', modelId: 'deepseek-flash', enabled: true,
  baseUrl: 'http://127.0.0.1:1/v1', apiKeyRef: 'file-secret:anyfusion/internal/llm',
}), { mode: 0o600 });
await writeFile(join(root, 'internal/llm-credentials.json'), JSON.stringify({
  internal: { llm: 'isolated-desktop-fixture-not-a-real-key' },
}), { mode: 0o600 });
await mkdir(evidence, { recursive: true });

function run(args, environment = env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: source, env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun()
      : reject(new Error(`Isolated Desktop check exited ${code ?? signal}`)));
  });
}

let passed = false;
let cleanupPassed = false;
try {
  const preparationEnvironment = { ...env };
  // The development launcher checks this variable against its private root,
  // then supplies both installation aliases to its own children.
  delete preparationEnvironment.METAWORK_INSTALL_ROOT;
  delete preparationEnvironment.ANYFUSION_INSTALL_ROOT;
  await run(['scripts/dev-desktop.mjs', '--prepare-only', '--production-assets'], preparationEnvironment);
  await run(['apps/desktop/tests/electron-smoke.mjs']);
  await cp(join(root, 'evidence'), join(evidence, 'electron'), { recursive: true });
  for (const name of ['desktop-1440.png', 'desktop-1100.png', 'desktop-900.png', 'desktop-200-percent.png']) {
    await cp(join(root, name), join(evidence, name));
  }
  passed = true;
} finally {
  try {
    const manifest = await readFile(join(root, 'server-endpoint.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest !== null) await run([join(root, 'app/current/dist/index.js'), 'server', 'stop']);
    cleanupPassed = true;
  } finally {
    await writeFile(join(evidence, 'result.json'), JSON.stringify({
      passed: passed && cleanupPassed, platform: process.platform, arch: process.arch,
      node: process.version, isolatedRoot: root, cleanupPassed,
      developmentShell: true, productionWebAssets: true,
      packagedInstallVerified: false, realModelTaskVerified: false,
    }, null, 2));
    process.stdout.write(`Isolated Desktop evidence: ${evidence}\n`);
  }
}
