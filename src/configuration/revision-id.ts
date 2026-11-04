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
 * The *end* of the suffix is the part that carries identity (a uuid, a release
 * id, a timestamp), so an over-long input is trimmed from its description side,
 * never from its tail. Trimming only the head was not enough: an upgrade id of
 * `<releaseId>-<uuid>` for the 25-character internal release id
 * `0.1.24-desktoppayload-1903` already fills the 64-character budget, and the
 * resulting over-long id failed every Desktop upgrade for that build.
 */
export function createConfigurationRevisionId(prefix: string, unique: string): string {
  const head = configurationReferenceSlug(prefix);
  const tail = configurationReferenceSlug(unique);
  const budget = CONFIGURATION_REFERENCE_MAX_LENGTH - head.length - 1;
  const trimmedTail = tail.length <= budget
    ? tail
    // Keep the tail's suffix (its entropy) and drop leading dashes left behind.
    : tail.slice(tail.length - Math.max(1, budget)).replace(/^-+/u, '');
  let id = `${head}-${trimmedTail}`;
  if (id.length > CONFIGURATION_REFERENCE_MAX_LENGTH) {
    // Only an oversized prefix reaches here; shorten it, never the unique suffix.
    const headBudget = CONFIGURATION_REFERENCE_MAX_LENGTH - trimmedTail.length - 1;
    id = `${head.slice(0, Math.max(1, headBudget)).replace(/-+$/u, '') || 'r'}-${trimmedTail}`;
  }
  if (!CONFIGURATION_REFERENCE_PATTERN.test(id)) {
    throw new Error(`configuration revision id is not a valid reference: ${id} `
      + `(max ${CONFIGURATION_REFERENCE_MAX_LENGTH} characters)`);
  }
  return id;
}

export function isValidConfigurationRevisionId(value: string): boolean {
  return CONFIGURATION_REFERENCE_PATTERN.test(value);
}
