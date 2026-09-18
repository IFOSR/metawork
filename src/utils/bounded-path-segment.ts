import { createHash } from 'node:crypto';

/**
 * Deterministic, filesystem-safe directory name for a durable identity.
 *
 * Durable IDs stay unchanged in the database and in every handle/URI; only the
 * on-disk directory name is shortened. Deep `<taskId>/<generationId>/<subtaskId>`
 * nesting repeats the same long hash at every level, which overflowed
 * `NAME_MAX` (255 bytes per component) and broke tools that flatten a path into
 * a single name.
 *
 * The mapping is pure: any process, restart or recovery step recomputes the same
 * directory name from the same identity, so no lookup table or migration is
 * involved. `readable` keeps a bounded prefix/suffix of the id for operators;
 * `digest` disambiguates collisions.
 */
export function boundedPathSegment(
  identity: string,
  options: {
    /** Short level marker, e.g. `t` for task, `a` for attempt. */
    prefix?: string;
    /** How many readable characters of the identity to keep. */
    readable?: number;
    /** Which end of the identity the readable part comes from. */
    from?: 'start' | 'end';
    /** Digest characters appended for uniqueness. */
    digest?: number;
  } = {},
): string {
  const prefix = options.prefix ?? '';
  const readableLimit = options.readable ?? 12;
  const digestLength = options.digest ?? 8;
  const safe = identity.replace(/[^A-Za-z0-9._-]/gu, '_');
  const readable = (options.from === 'end' ? safe.slice(-readableLimit) : safe.slice(0, readableLimit))
    .replace(/^[._-]+|[._-]+$/gu, '');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, digestLength);
  return [prefix, readable, digest].filter(Boolean).join('_');
}
