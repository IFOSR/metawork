/**
 * Isolated environment for the Manager process (ADR-0055 D6).
 *
 * The Manager must never read the user's own Pi home, sessions, extensions, auth
 * files or provider keys from the ambient environment: a stale personal config is
 * exactly how a packaged product ends up running against an untested runtime.
 * Only an explicit allow-list crosses the boundary, plus the MetaWork-provided
 * home/config/session roots.
 */

/** Ambient variables that may pass through unchanged. */
const PASSTHROUGH = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
] as const;

export interface ManagerEnvironmentInput {
  /** Absolute, MetaWork-owned home; also becomes `HOME` for the child. */
  readonly managerHome: string;
  /** Pi configuration root, created and owned by MetaWork. */
  readonly configDir: string;
  /** Pi session root; per-turn sessions are written here, never to the user's home. */
  readonly sessionDir: string;
  /** Provider/secret entries the Runtime explicitly decided to pass. */
  readonly explicit: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

export interface ManagerEnvironment {
  readonly env: NodeJS.ProcessEnv;
  /** Variables that were dropped from the ambient environment (for diagnostics). */
  readonly dropped: readonly string[];
}

export function buildManagerEnvironment(
  input: ManagerEnvironmentInput,
  ambient: NodeJS.ProcessEnv = process.env,
): ManagerEnvironment {
  const platform = input.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    const value = ambient[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = input.managerHome;
  if (platform === 'win32') {
    env.USERPROFILE = input.managerHome;
  }
  env.PI_CODING_AGENT_DIR = input.configDir;
  env.PI_CODING_AGENT_SESSION_DIR = input.sessionDir;
  env.METAWORK_MANAGER_HOST_PROTOCOL = '1';
  // The Manager is a MetaWork component: it reports usage to the Runtime, never
  // to a user-level telemetry sink.
  env.PI_TELEMETRY = 'off';
  for (const [key, value] of Object.entries(input.explicit)) {
    if (!key.trim()) continue;
    env[key] = value;
  }

  const dropped = Object.keys(ambient)
    .filter(key => !(key in env))
    // Configuration that could redirect the Manager at a user-level Pi install.
    .filter(key => /^(?:PI_|ANYFUSION_|METACLAW_|METAWORK_PI_)/u.test(key)
      || key === 'HOME'
      || key === 'USERPROFILE'
      || key === 'NODE_OPTIONS')
    .sort();
  return { env, dropped };
}
