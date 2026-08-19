// Runs MetaClaw sessions from plain-text scripts, including task-id placeholder
// substitution between submitted lines.
import { readFileSync } from 'fs';
import type { SessionSnapshot } from './session-types.js';

export interface ScriptedSessionPort {
  initialize(options?: { showDashboard?: boolean }): void;
  getSnapshot(): SessionSnapshot;
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
    if (!resolved.includes(placeholder)) {
      continue;
    }

    if (!value) {
      throw new Error(`脚本占位符 ${placeholder} 当前不可用`);
    }

    resolved = resolved.replaceAll(placeholder, value);
  }

  return resolved;
}

export async function runScriptedSession(
  input: { inputs: string[]; session: ScriptedSessionPort },
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
      if (snapshotAfterSubmit.currentTaskId) {
        lastTaskId = snapshotAfterSubmit.currentTaskId;
      }
      if (result.exitRequested) {
        exitRequested = true;
        break;
      }
    }

    return {
      output: session.getSnapshot().output,
      exitRequested,
    };
  } finally {
    await session.dispose();
  }
}

export async function runScriptedSessionFile(
  scriptPath: string,
  session: ScriptedSessionPort,
): Promise<{ output: string[]; exitRequested: boolean }> {
  const content = readFileSync(scriptPath, 'utf-8');
  return runScriptedSession({
    session,
    inputs: parseScriptInputs(content),
  });
}
