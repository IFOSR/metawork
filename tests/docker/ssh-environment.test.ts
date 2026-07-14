import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function readEnvironmentFile(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

describe('SSH login environment', () => {
  it('persists MetaClaw runtime paths for sessions started by sshd', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-ssh-environment-'));
    const environmentPath = join(directory, 'environment');
    const helperPath = resolve('docker/persist-ssh-environment.sh');

    try {
      writeFileSync(environmentPath, 'LANG=C.UTF-8\n');
      execFileSync(
        'bash',
        ['-c', 'source "$1"; persist_ssh_environment "$2"', 'bash', helperPath, environmentPath],
        {
          env: {
            ...process.env,
            OPENAI_BASE_URL: 'https://example.invalid/v1',
            METACLAW_HOME: '/test/data/metaclaw',
            METACLAW_PLANNER_CODEX_HOME: '/test/codex/planner',
            METACLAW_EXECUTOR_CODEX_HOME: '/test/codex/executor',
            METACLAW_PLANNER_SCHEMA_PATH: '/test/schema/planning-agent-plan-v2.schema.json',
            METACLAW_PLANNER_WORKDIR: '/test/workdir/planner',
          },
        },
      );

      expect(Object.fromEntries(readEnvironmentFile(environmentPath))).toMatchObject({
        LANG: 'C.UTF-8',
        METACLAW_HOME: '/test/data/metaclaw',
        METACLAW_PLANNER_CODEX_HOME: '/test/codex/planner',
        METACLAW_EXECUTOR_CODEX_HOME: '/test/codex/executor',
        METACLAW_PLANNER_SCHEMA_PATH: '/test/schema/planning-agent-plan-v2.schema.json',
        METACLAW_PLANNER_WORKDIR: '/test/workdir/planner',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
