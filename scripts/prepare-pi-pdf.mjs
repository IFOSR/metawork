import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const exec = promisify(execFile);
const source = resolve('integrations/pi-pdf');
const requirements = await readFile(join(source, 'requirements.txt'));
// A relocatable, pinned interpreter is part of the release, not a user prerequisite.
const pythonRelease = JSON.parse(await readFile(new URL('./pi-pdf-python.json', import.meta.url), 'utf8'));
const asset = pythonRelease.assets[`${process.platform}-${process.arch}`];
if (!asset) throw new Error(`Pi PDF runtime has no prepared Python distribution for ${process.platform}/${process.arch}`);
const pythonCache = resolve('.tmp/pi-pdf-python', asset.sha256);
const python = join(pythonCache, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3');
if (!(await readFile(join(pythonCache, 'ready')).catch(() => null))) {
  await mkdir(pythonCache, { recursive: true });
  const archive = join(pythonCache, 'python.tar.gz');
  const name = `cpython-${pythonRelease.version}+${pythonRelease.release}-${asset.target}-install_only_stripped.tar.gz`;
  await exec('curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '300',
    '--output', archive, `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonRelease.release}/${encodeURIComponent(name)}`]);
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== asset.sha256) throw new Error('Pi PDF Python archive checksum mismatch');
  await exec('tar', ['-xzf', archive, '-C', pythonCache]);
  await exec(python, ['-I', '-c', 'import ssl,sys;assert sys.version_info[:2] == (3,12)']);
  await writeFile(join(pythonCache, 'ready'), asset.sha256);
}
const { stdout: identity } = await exec(python, ['-c', 'import sys,platform;assert sys.version_info >= (3,9);print(sys.version,platform.machine())']);
// cryptography 50 retains source support but no longer publishes Intel macOS
// wheels. Build that pinned dependency with static OpenSSL on the build host;
// installed users still receive the complete relocatable binary payload.
const intelMac = process.platform === 'darwin' && process.arch === 'x64';
const fingerprint = createHash('sha256').update(requirements).update(identity)
  .update(intelMac ? 'intel-static-cryptography-v1' : '').digest('hex').slice(0,16);
const cache = resolve('.tmp/pi-pdf-dependencies', fingerprint);
const ready = join(cache, 'ready');
if (!(await readFile(ready).catch(() => null))) {
  await mkdir(cache, { recursive: true });
  const buildEnvironment = { ...process.env };
  if (intelMac) {
    await exec('rustc', ['--version']);
    const { stdout } = await exec('brew', ['--prefix', 'openssl@3']);
    const openssl = stdout.trim();
    await access(join(openssl, 'lib/libssl.a'));
    await access(join(openssl, 'lib/libcrypto.a'));
    for (const key of Object.keys(buildEnvironment)) if (key.startsWith('OPENSSL_')) delete buildEnvironment[key];
    Object.assign(buildEnvironment, { OPENSSL_DIR: openssl, OPENSSL_STATIC: '1' });
  }
  await exec(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:',
    ...(intelMac ? ['--no-binary=cryptography'] : []),
    '--target', join(cache, 'site-packages'), '-r', join(source, 'requirements.txt')], {
    env: buildEnvironment, maxBuffer: 4 * 1024 * 1024,
  });
  if (intelMac) {
    const { stdout } = await exec('otool', ['-L', join(cache, 'site-packages/cryptography/hazmat/bindings/_rust.abi3.so')]);
    for (const line of stdout.split('\n').slice(1).filter(line => line.trim())) {
      if (!/^\s*\/(?:usr\/lib|System\/Library)\//u.test(line)) {
        throw new Error('Intel PDF cryptography must not depend on build-host dynamic libraries');
      }
    }
  }
  await writeFile(ready, identity);
}
const destination = resolve('dist/pi-pdf');
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await cp(join(pythonCache, 'python'), join(destination, 'python'), { recursive: true, dereference: true });
await cp(join(cache, 'site-packages'), join(destination, 'site-packages'), { recursive: true });
await exec(python, ['-I', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import pypdf,pdfplumber,pypdfium2,PIL;print("Pi PDF dependencies ready")', join(destination, 'site-packages')]);
process.stdout.write(`System Pi PDF extension prepared (${process.platform}/${process.arch}).\n`);
