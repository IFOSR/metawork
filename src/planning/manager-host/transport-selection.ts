/**
 * Planning transport selection (ADR-0055 D6).
 *
 * The Manager transport is the default: MetaWork runs the packaged upstream Pi.
 * The vendored Planner survives only as an explicit, temporary opt-out so a
 * bisect or a rollback can still reach it; an unknown value fails instead of
 * silently falling back, because "silently ran the wrong runtime" is exactly the
 * defect class this migration removes.
 */
export type PlanningTransport = 'vendored-planner' | 'upstream-pi';

const VENDORED = new Set(['vendored', 'vendored-planner', 'legacy']);
const UPSTREAM = new Set(['', 'upstream-pi', 'pi', 'manager']);

export function resolvePlanningTransport(env: NodeJS.ProcessEnv = process.env): PlanningTransport {
  const raw = (env.METAWORK_MANAGER_TRANSPORT ?? '').trim().toLowerCase();
  if (UPSTREAM.has(raw)) return 'upstream-pi';
  if (VENDORED.has(raw)) return 'vendored-planner';
  throw new Error(
    `METAWORK_MANAGER_TRANSPORT must be one of vendored-planner, upstream-pi (got ${raw})`,
  );
}
