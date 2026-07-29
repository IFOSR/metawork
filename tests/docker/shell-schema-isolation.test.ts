import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Docker shell SQLite schema isolation', () => {
  it('uses a data volume scoped to the current pre-release schema', () => {
    const migrations = readFileSync(
      resolve('src/storage/migrations.ts'),
      'utf-8',
    );
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const version = migrations.match(/CURRENT_SCHEMA_VERSION = (\d+);/)?.[1];

    expect(version).toBeTruthy();
    expect(shell).toContain(
      `$dataVolume = 'metaclaw-shell-data-v${version}'`,
    );
  });
});
