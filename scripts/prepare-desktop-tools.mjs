import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// The reviewed archive contains node/, git/ and executor/ with complete licenses
// and libraries. Its checksum is release configuration, never supplied by the download.
const [url, checksum, outputArg] = process.argv.slice(2);
if (!url || new URL(url).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(checksum ?? '') || !outputArg) {
  throw new Error('Usage: prepare-desktop-tools.mjs HTTPS_URL SHA256 NEW_OUTPUT_DIRECTORY');
}
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
const archive = join(output, 'tools.tar.gz');
try {
  execFileSync('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--retry', '2', '--connect-timeout', '20', '--max-time', '600', '--output', archive, url], { stdio: 'inherit' });
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== checksum) throw new Error('Desktop tool archive checksum mismatch');
  const entries = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  if (entries.some(path => !/^(node|git|executor)\//.test(path) || path.includes('\\')
    || path.split('/').includes('..'))) throw new Error('Invalid Desktop tool archive path');
  const details = execFileSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  if (details.some(line => !['-', 'd', 'h'].includes(line[0]))) throw new Error('Desktop tools must not contain links or special entries');
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', output]);
  await rm(archive);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
