import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Validate physical identity while preserving the paths in the durable request. */
export async function resolveDesktopUpdateRoot(rootArg: string, requestArg: string): Promise<string> {
  const root = resolve(rootArg);
  const canonicalRoot = await realpath(root);
  if (await realpath(requestArg) !== join(canonicalRoot, 'upgrades/desktop-request.json')) {
    throw new Error('Invalid update request path');
  }
  return root;
}
