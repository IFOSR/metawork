import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writePackagedPiFixture(root: string, version = '1.5.0') {
  const lock = '{"lockfileVersion":3}\n';
  const lockSha256 = createHash('sha256').update(lock).digest('hex');
  const packageRoot = join(root, 'runtime/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent', version, bin: { pi: 'dist/cli.js' },
  }));
  writeFileSync(join(packageRoot, 'dist/cli.js'), `console.log(${JSON.stringify(version)});`);
  writeFileSync(join(root, 'runtime/package-lock.json'), lock);
  writeFileSync(join(root, 'pi-runtime-pin.json'), JSON.stringify({
    version, packageName: '@earendil-works/pi-coding-agent', entry: 'dist/cli.js', lockSha256,
  }));
  writeFileSync(join(root, 'bin/pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { version, lockSha256, url: 'https://example.test/pi.tar.gz', byteSize: 1, sha256: 'b'.repeat(64) };
}
