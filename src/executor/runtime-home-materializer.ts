import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  MaterializedRuntimeHome,
  RuntimeHomeInput,
} from './harness-driver.js';

export interface RuntimeHomeMaterializationInput extends RuntimeHomeInput {
  environment: Record<string, string>;
}

export class RuntimeHomeMaterializer {
  constructor(readonly attemptsRoot: string) {}

  async materialize(
    input: RuntimeHomeMaterializationInput,
  ): Promise<MaterializedRuntimeHome> {
    const attemptId = safeSegment(input.attemptId, 'attemptId');
    const attemptRoot = resolve(this.attemptsRoot, attemptId);
    const homePath = join(attemptRoot, 'home');
    const logsPath = join(attemptRoot, 'logs');
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await mkdir(logsPath, { recursive: true, mode: 0o700 });
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
}

function safeSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label} is not a safe runtime identity`);
  }
  return value;
}
