import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const executorServiceFiles = [
  'agent-class-service',
  'harness-driver-registry',
  'local-cli-executor-adapter',
  'container-compatibility-adapter',
];

describe('executor module architecture boundaries', () => {
  it('keeps executor service implementations in src/executor and out of core', () => {
    for (const file of executorServiceFiles) {
      expect(existsSync(resolve(projectRoot, `src/executor/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });

  it('carries the authorization identity a future A2A envelope requires', () => {
    const adapterSource = readFileSync(resolve(projectRoot, 'src/executor/adapter.ts'), 'utf8');
    for (const field of [
      'authorization',
      'configurationRevision',
      'bindingFingerprint',
      'agentClassRef',
      'harnessRef',
      'providerRef',
      'modelRef',
      'permissionProfileRef',
      'idempotencyKey',
    ]) {
      expect(adapterSource).toContain(field);
    }
  });

  it('keeps the adapter contract transport-neutral without an A2A variant', () => {
    const adapterSource = readFileSync(resolve(projectRoot, 'src/executor/adapter.ts'), 'utf8');
    expect(adapterSource).toContain('transport-neutral');
    expect(adapterSource).not.toContain('A2A_TRANSPORT');
    expect(adapterSource).not.toContain('a2aTransport');
    expect(adapterSource).not.toContain('remoteEndpoint');
  });
});
