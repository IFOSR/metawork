import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReleasePointerTransaction,
  type ReleasePointerName,
} from '../../src/installation/release-pointer-transaction.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ReleasePointerTransaction', () => {
  it('switches the complete compatible set and runs health before commit', async () => {
    const fixture = pointerFixture();
    const calls: string[] = [];
    const transaction = new ReleasePointerTransaction({
      paths: fixture.paths,
      afterSwitch: async name => { calls.push(name); },
      healthCheck: async () => { calls.push('health'); },
    });

    await transaction.activate(fixture.candidate);

    expect(readTargets(fixture.paths)).toEqual(fixture.candidate);
    expect(calls).toEqual(['database', 'configuration', 'generated', 'application', 'health']);
  });

  it('restores every old pointer after each switch failure and health failure', async () => {
    for (const failAt of [
      'database',
      'configuration',
      'generated',
      'application',
      'health',
    ] as const) {
      const fixture = pointerFixture();
      const transaction = new ReleasePointerTransaction({
        paths: fixture.paths,
        afterSwitch: async name => {
          if (name === failAt) throw new Error(`failure after ${name}`);
        },
        healthCheck: async () => {
          if (failAt === 'health') throw new Error('candidate unhealthy');
        },
      });

      await expect(transaction.activate(fixture.candidate)).rejects.toThrow();

      expect(readTargets(fixture.paths), failAt).toEqual(fixture.previous);
    }
  });

  it('recovers a crash from a durable prepared journal before a new update', async () => {
    const fixture = pointerFixture();
    const journalPath = join(dirname(fixture.paths.application), 'activation.json');
    const transaction = new ReleasePointerTransaction({
      paths: fixture.paths,
      journalPath,
      healthCheck: async () => undefined,
    });
    await transaction.activate(fixture.candidate);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      phase: string;
      previousTargets: Record<ReleasePointerName, string>;
    };
    journal.phase = 'prepared';
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    rmSync(fixture.paths.database);
    symlinkSync(fixture.candidate.database, fixture.paths.database);
    rmSync(fixture.paths.configuration);
    symlinkSync(fixture.previous.configuration, fixture.paths.configuration);

    const result = await transaction.recover();

    expect(result).toEqual({ status: 'rolled_back' });
    expect(readTargets(fixture.paths)).toEqual(fixture.previous);
  });
});

function pointerFixture(): {
  paths: Record<ReleasePointerName, string>;
  previous: Record<ReleasePointerName, string>;
  candidate: Record<ReleasePointerName, string>;
} {
  const root = mkdtempSync(join(tmpdir(), 'anyfusion-pointer-transaction-'));
  cleanup.push(root);
  const paths = {
    database: join(root, 'data', 'metaclaw.db'),
    configuration: join(root, 'config', 'active'),
    generated: join(root, 'generated', 'current'),
    application: join(root, 'app', 'current'),
  };
  const previous = {
    database: 'database-revisions/old.db',
    configuration: 'revisions/old',
    generated: 'agent-runtime/old',
    application: 'releases/old',
  };
  const candidate = {
    database: 'database-revisions/new.db',
    configuration: 'revisions/new',
    generated: 'agent-runtime/new',
    application: 'releases/new',
  };
  for (const name of Object.keys(paths) as ReleasePointerName[]) {
    mkdirSync(dirname(paths[name]), { recursive: true });
    symlinkSync(previous[name], paths[name]);
  }
  return { paths, previous, candidate };
}

function readTargets(
  pathsOrTargets: Record<ReleasePointerName, string>,
): Record<ReleasePointerName, string> {
  return Object.fromEntries(
    (Object.keys(pathsOrTargets) as ReleasePointerName[]).map(name => [
      name,
      readlinkSync(pathsOrTargets[name]),
    ]),
  ) as Record<ReleasePointerName, string>;
}
