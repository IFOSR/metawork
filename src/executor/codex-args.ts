// Builds the Codex CLI non-interactive exec arguments used by Codex integrations.
export interface CodexNonInteractiveArgsOptions {
  ephemeral?: boolean;
  json?: boolean;
  outputLastMessagePath?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  modelId?: string;
  providerRef?: string;
}

export function buildCodexNonInteractiveArgs(
  prompt: string,
  options: CodexNonInteractiveArgsOptions = {},
): string[] {
  return [
    'exec',
    ...((options.json ?? false) ? ['--json'] : []),
    '--sandbox',
    options.sandbox ?? 'workspace-write',
    ...(options.providerRef && options.modelId
      ? ['-c', `model="${options.modelId}"`, '-c', `model_provider="${options.providerRef}"`]
      : []),
    '-c',
    'approval_policy="never"',
    '--skip-git-repo-check',
    ...((options.ephemeral ?? true) ? ['--ephemeral'] : []),
    ...(options.outputLastMessagePath
      ? ['--output-last-message', options.outputLastMessagePath]
      : []),
    '--color',
    'never',
    prompt,
  ];
}

export function buildCodexResumeArgs(
  sessionId: string,
  prompt: string,
  options: CodexNonInteractiveArgsOptions = {},
): string[] {
  return [
    'exec',
    'resume',
    '--sandbox',
    options.sandbox ?? 'workspace-write',
    '-c',
    'approval_policy="never"',
    '--skip-git-repo-check',
    '--json',
    ...(options.outputLastMessagePath ? ['--output-last-message', options.outputLastMessagePath] : []),
    '--color',
    'never',
    sessionId,
    prompt,
  ];
}
