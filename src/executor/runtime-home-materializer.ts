import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  MaterializedRuntimeHome,
  RuntimeHomeInput,
} from './harness-driver.js';

export interface RuntimeHomeMaterializationInput extends Omit<RuntimeHomeInput, 'attemptsRoot'> {
  environment: Record<string, string>;
  homeDirectories?: string[];
}

export class RuntimeHomeMaterializer {
  constructor(readonly attemptsRoot: string) {}

  async materialize(
    input: RuntimeHomeMaterializationInput,
  ): Promise<MaterializedRuntimeHome> {
    const { attemptRoot, homePath, logsPath } = this.resolvePaths(input.attemptId);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await mkdir(logsPath, { recursive: true, mode: 0o700 });
    for (const relativePath of input.homeDirectories ?? []) {
      await mkdir(resolveInside(homePath, relativePath), { recursive: true, mode: 0o700 });
    }
    await writeFile(
      join(attemptRoot, 'environment.json'),
      `${JSON.stringify({
        redacted: true,
        attemptId: input.attemptId,
        revisionId: input.revisionId,
        agentClassId: input.agentClassId,
        bindingFingerprint: input.bindingFingerprint,
        environment: input.environment,
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await writeFile(
      join(attemptRoot, 'receipt.json'),
      `${JSON.stringify({ status: 'pending', attemptId: input.attemptId }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return { homePath, environment: { ...input.environment } };
  }

  resolvePaths(attemptId: string): {
    attemptRoot: string;
    homePath: string;
    logsPath: string;
  } {
    const safeAttemptId = safeSegment(attemptId, 'attemptId');
    const attemptRoot = resolve(this.attemptsRoot, safeAttemptId);
    return {
      attemptRoot,
      homePath: join(attemptRoot, 'home'),
      logsPath: join(attemptRoot, 'logs'),
    };
  }
}

function safeSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label} is not a safe runtime identity`);
  }
  return value;
}

function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new Error('runtime home directory must be relative');
  }
  const resolved = resolve(root, relativePath);
  if (!resolved.startsWith(`${resolve(root)}/`)) {
    throw new Error('runtime home directory escapes attempt home');
  }
  return resolved;
}
