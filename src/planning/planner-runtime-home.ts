import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export async function materializePlannerRuntimeHome(input: {
  sourceHome: string;
  runtimeRoot: string;
  revisionId: string;
}): Promise<string> {
  const sourceHome = resolve(input.sourceHome);
  const runtimeRoot = resolve(input.runtimeRoot);
  const target = resolve(runtimeRoot, input.revisionId);
  if (escapes(runtimeRoot, target)) {
    throw new Error(`Planner runtime revision escapes its root: ${input.revisionId}`);
  }

  const source = await stat(sourceHome).catch(() => null);
  if (!source?.isDirectory()) {
    throw new Error(`Planner generated home is unavailable: ${sourceHome}`);
  }
  const existing = await stat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Planner runtime home is not a directory: ${target}`);
    }
    await chmod(target, 0o700);
    return target;
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const staged = `${target}.tmp-${randomUUID()}`;
  try {
    await cp(sourceHome, staged, { recursive: true, force: false });
    await chmod(staged, 0o700);
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    const concurrent = await stat(target).catch(() => null);
    if (!concurrent?.isDirectory()) throw error;
    await chmod(target, 0o700);
  }
  return target;
}

function escapes(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '..' || path.startsWith('../') || path.startsWith('..\\');
}
