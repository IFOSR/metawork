/**
 * Configuration revision identifiers.
 *
 * A revision id is a configuration reference: the Planner declares it in a Work
 * Graph, the routing catalog reports it, and the Kernel binds Executor
 * authorization to it. The reference grammar is therefore shared with every other
 * configuration reference (`modelRef`, `agentClassRef`, secret references), and a
 * revision id outside that grammar cannot be expressed in a proposal at all.
 *
 * A rollback once produced `rollback-0.1.21-local-final-0826-<uuid>`: 69 characters
 * with dots. The Planner could not submit any valid plan afterwards — the proposal
 * schema rejected the authoritative value while the validator required it — so
 * every task-like request failed. Identify ids through this module, never by string
 * concatenation.
 */

/** Shared configuration reference grammar. */
export const CONFIGURATION_REFERENCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const CONFIGURATION_REFERENCE_MAX_LENGTH = 64;

/**
 * Folds an arbitrary label into the reference grammar: lowercase, ASCII, dashes
 * only, no repeated or leading/trailing dashes, and no leading digit.
 */
export function configurationReferenceSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!slug) return 'unknown';
  // A reference must start with a letter.
  return /^[a-z]/u.test(slug) ? slug : `r-${slug}`;
}

/**
 * Builds a legal configuration revision id from a prefix and a unique suffix.
 *
 * The suffix keeps its identity (trimmed, not dropped) and the prefix is shortened
 * when the pair would exceed the grammar's length budget.
 */
export function createConfigurationRevisionId(prefix: string, unique: string): string {
  const head = configurationReferenceSlug(prefix);
  const tail = configurationReferenceSlug(unique);
  const budget = CONFIGURATION_REFERENCE_MAX_LENGTH - tail.length - 1;
  const trimmedHead = head.slice(0, Math.max(1, budget)).replace(/-+$/u, '') || 'r';
  const id = `${trimmedHead}-${tail}`;
  if (!CONFIGURATION_REFERENCE_PATTERN.test(id)) {
    throw new Error(`configuration revision id is not a valid reference: ${id}`);
  }
  return id;
}

export function isValidConfigurationRevisionId(value: string): boolean {
  return CONFIGURATION_REFERENCE_PATTERN.test(value);
}
