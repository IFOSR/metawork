// Builds the Codex CLI non-interactive exec arguments used by Codex integrations.
export interface CodexNonInteractiveArgsOptions {
  ephemeral?: boolean;
  outputLastMessagePath?: string;
}

export function buildCodexNonInteractiveArgs(
  prompt: string,
  options: CodexNonInteractiveArgsOptions = {},
): string[] {
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
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
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--skip-git-repo-check',
    '--json',
    ...(options.outputLastMessagePath ? ['--output-last-message', options.outputLastMessagePath] : []),
    '--color',
    'never',
    sessionId,
    prompt,
  ];
}
