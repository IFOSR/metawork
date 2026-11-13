import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPiRuntimePin } from './pi-runtime-pin.mjs';

const packagePath = 'node_modules/@earendil-works/pi-coding-agent';

/** Copy only the pinned release, never the host's auth, sessions or launcher. */
export async function stagePackagedPi(pin, output) {
  const staging = `${output}.stage-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await cp(pin.releaseDir, join(staging, 'runtime'), { recursive: true, dereference: true });
    const pkg = JSON.parse(await readFile(join(staging, 'runtime', packagePath, 'package.json'), 'utf8'));
    const rawEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
    const entry = typeof rawEntry === 'string' ? rawEntry.replace(/^\.\//u, '') : rawEntry;
    const packageRoot = resolve(staging, 'runtime', packagePath);
    if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== pin.version
      || typeof entry !== 'string' || !/^[A-Za-z0-9_./-]+$/u.test(entry)
      || !resolve(packageRoot, entry).startsWith(`${packageRoot}${sep}`)) {
      throw new Error('Packaged Pi package/version/entry mismatch');
    }
    await readFile(join(packageRoot, entry));
    const lockHash = createHash('sha256').update(await readFile(join(staging, 'runtime/package-lock.json'))).digest('hex');
    if (!pin.lockSha256 || lockHash !== pin.lockSha256) throw new Error('Packaged Pi lock integrity mismatch');
    await mkdir(join(staging, 'bin'));
    // The Desktop has a sibling Node distribution. Source/native installs use
    // their supported host Node, but never resolve Pi from PATH.
    await writeFile(join(staging, 'bin/pi'), `#!/bin/sh
set -eu
tool_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node_command="$tool_root/../node/bin/node"
if [ ! -x "$node_command" ]; then node_command=node; fi
exec "$node_command" "$tool_root/runtime/${packagePath}/${entry}" "$@"
`, { mode: 0o755 });
    await writeFile(join(staging, 'pi-runtime-pin.json'), `${JSON.stringify({
      version: pin.version, packageName: pkg.name, entry, lockSha256: lockHash,
      ...(pin.nodeEngine ? { nodeEngine: pin.nodeEngine } : {}),
    }, null, 2)}\n`);
    await mkdir(dirname(output), { recursive: true });
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Refresh a build input after validation; installed immutable releases are untouched. */
export async function prepareSourcePi(sourceRoot, options = {}) {
  const pin = assertPiRuntimePin(options);
  const output = join(sourceRoot, 'desktop-tools/executor');
  const candidate = `${output}.candidate-${randomUUID()}`;
  await stagePackagedPi(pin, candidate);
  await rm(output, { recursive: true, force: true });
  await rename(candidate, output);
  return pin;
}
