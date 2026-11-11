import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMetaWorkPaths } from './paths.js';

/**
 * Generated files the runtime loads at execution time. They are produced by
 * separate build steps, so a plain `tsup` (which clears `dist/`) leaves the
 * Server apparently healthy but every attempt fails at preparation time with
 * an ENOENT that users cannot act on. `metawork build` produces all of them;
 * `server start` verifies them before it accepts any work.
 */
export const REQUIRED_RUNTIME_ARTIFACTS = [
  'dist/pi-attempt-tools.ts',
  'dist/planning-agent-plan-v9.schema.json',
] as const;

export interface RuntimeArtifactCheck {
  readonly ok: boolean;
  readonly root: string;
  readonly missing: readonly string[];
}

export function checkRuntimeArtifacts(
  appRoot: string = resolveMetaWorkPaths().appCurrent,
): RuntimeArtifactCheck {
  const missing = REQUIRED_RUNTIME_ARTIFACTS
    .filter(relativePath => !existsSync(join(appRoot, relativePath)));
  return { ok: missing.length === 0, root: appRoot, missing };
}

export function assertCompleteRuntime(
  appRoot: string = resolveMetaWorkPaths().appCurrent,
): void {
  const check = checkRuntimeArtifacts(appRoot);
  if (check.ok) return;
  throw new Error(
    'MetaWork runtime is incomplete: missing generated build artifacts '
    + `${check.missing.join(', ')} under ${check.root}. Run \`metawork build\` `
    + '(or tsup plus the planner-schema and pi-attempt-extension generators) '
    + 'before starting the Server.',
  );
}
