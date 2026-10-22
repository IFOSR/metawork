import { redactSensitiveText } from './redact-sensitive-text.js';

// Match absolute runtime paths, while preserving user Workspace and ordinary
// source paths. This same boundary applies before hashing public result bytes.
const INTERNAL_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]*?(?:workspace-store[\\/]|[.]metawork[\\/](?:accounts|app|runtime|logs|tmp)[\\/]|[.]metaclaw[\\/]|managed-services[\\/]|(?:metawork-delivery-|metawork-public-index-)[^\s<>"'`]*|(?:attempts|worktrees|bare-repos)[\\/])[^\s<>"'`]*/gu;

export function containsInternalRuntimePath(text: string): boolean {
  INTERNAL_PATH.lastIndex = 0;
  return INTERNAL_PATH.test(text);
}

export function publicText(text: string): string {
  INTERNAL_PATH.lastIndex = 0;
  return redactSensitiveText(text).replace(INTERNAL_PATH, '[内部路径]');
}
