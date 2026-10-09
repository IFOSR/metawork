// Test tooling only. The installer is copied byte-for-byte from the verified
// Windows candidate; no provider configuration or signing key enters this kit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const [candidateArg, toolsArg, outputArg] = process.argv.slice(2);
assert.ok(candidateArg && toolsArg && outputArg);
const candidate = resolve(candidateArg), output = resolve(outputArg);
await mkdir(output, { recursive: false });
const installer = 'MetaWork-win32-x64-setup.exe';
await cp(join(candidate, 'shell', installer), join(output, installer));
await cp(join(resolve(toolsArg), 'node/node.exe'), join(output, 'node.exe'));
for (const name of ['packaged-install-smoke.mjs', 'packaged-model-task.mjs', 'packaged-browser.mjs', 'packaged-terminal.mjs', 'packaged-quit.mjs']) {
  const target = join(output, 'apps/desktop/tests', name);
  await mkdir(join(output, 'apps/desktop/tests'), { recursive: true });
  await cp(resolve('apps/desktop/tests', name), target);
}
await cp(resolve('apps/desktop/node_modules/playwright-core'), join(output, 'apps/desktop/node_modules/playwright-core'), { recursive: true });
await mkdir(join(output, '.tmp/windows-terminal-probe/Release'), { recursive: true });
await cp(resolve('.tmp/windows-terminal-probe/Release/metawork-terminal-client.exe'),
  join(output, '.tmp/windows-terminal-probe/Release/metawork-terminal-client.exe'));
await mkdir(join(output, 'scripts'));
await cp(resolve('scripts/probe-windows11-desktop.mjs'), join(output, 'scripts/probe-windows11-desktop.mjs'));
const descriptor = JSON.parse(await readFile(join(candidate, 'resources/desktop-release.json'), 'utf8'));
assert.equal(descriptor.sourceCommit, process.env.GITHUB_SHA);
await writeFile(join(output, 'acceptance-kit.json'), JSON.stringify({
  sourceCommit: descriptor.sourceCommit, releaseId: descriptor.releaseId, installer,
  installerSha256: createHash('sha256').update(await readFile(join(output, installer))).digest('hex'),
  scope: 'windows11-test-tooling-and-unchanged-installer', releaseAccepted: false,
}, null, 2));
