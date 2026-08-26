import { readFileSync } from 'node:fs';

export interface ScriptedSessionTestPort {
  initialize(options?: { showDashboard?: boolean }): void;
  getSnapshot(): {
    output: string[];
    currentTaskId: string | null;
  };
  submit(
    text: string,
    options?: { awaitAsyncWork?: boolean },
  ): Promise<{ exitRequested: boolean }>;
  dispose(): Promise<void>;
}

export function parseScriptInputs(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

export function resolveScriptPlaceholders(
  line: string,
  variables: {
    lastTaskId: string | null;
    currentTaskId: string | null;
  },
): string {
  const replacements: Array<[string, string | null]> = [
    ['{{last_task_id}}', variables.lastTaskId],
    ['{{current_task_id}}', variables.currentTaskId],
  ];

  let resolved = line;
  for (const [placeholder, value] of replacements) {
    if (!resolved.includes(placeholder)) continue;
    if (!value) throw new Error(`测试脚本占位符 ${placeholder} 当前不可用`);
    resolved = resolved.replaceAll(placeholder, value);
  }
  return resolved;
}

export async function runSessionInputs(
  input: { inputs: string[]; session: ScriptedSessionTestPort },
): Promise<{ output: string[]; exitRequested: boolean }> {
  const { inputs, session } = input;
  session.initialize();

  let exitRequested = false;
  let lastTaskId: string | null = null;
  try {
    for (const rawLine of inputs) {
      const snapshotBeforeSubmit = session.getSnapshot();
      const line = resolveScriptPlaceholders(rawLine, {
        lastTaskId,
        currentTaskId: snapshotBeforeSubmit.currentTaskId,
      });
      const result = await session.submit(line, { awaitAsyncWork: true });
      const snapshotAfterSubmit = session.getSnapshot();
      if (snapshotAfterSubmit.currentTaskId) lastTaskId = snapshotAfterSubmit.currentTaskId;
      if (result.exitRequested) {
        exitRequested = true;
        break;
      }
    }
    return { output: session.getSnapshot().output, exitRequested };
  } finally {
    await session.dispose();
  }
}

export async function runSessionInputFile(
  scriptPath: string,
  session: ScriptedSessionTestPort,
): Promise<{ output: string[]; exitRequested: boolean }> {
  return runSessionInputs({
    session,
    inputs: parseScriptInputs(readFileSync(scriptPath, 'utf8')),
  });
}
