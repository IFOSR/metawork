// Builds the Codex CLI non-interactive exec arguments used by the Codex executor adapter.
export function buildCodexNonInteractiveArgs(prompt: string): string[] {
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    prompt,
  ];
}
