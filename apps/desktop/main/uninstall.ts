import { link, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** NSIS owns a fresh temporary directory; only this bounded receipt is writable. */
export async function uninstallReceiptPath(input: string, temporaryRoot = tmpdir()): Promise<string> {
  if (input.length > 4096 || !isAbsolute(input) || basename(input) !== 'metawork-uninstall-result') {
    throw new Error('Invalid uninstall receipt');
  }
  const [root, parent] = await Promise.all([realpath(temporaryRoot), realpath(dirname(input))]);
  const child = relative(root, parent);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Uninstall receipt escapes temporary storage');
  return join(parent, 'metawork-uninstall-result');
}

export async function writeUninstallReceipt(path: string, approved: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, `${approved ? 'approved' : 'denied'}\r\n${process.pid}\r\n`, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); } finally { await rm(temporary, { force: true }); }
}
