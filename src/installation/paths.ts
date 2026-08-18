import { homedir } from 'os';
import { resolve } from 'path';

export interface AnyFusionPaths {
  root: string;
  appCurrent: string;
  releases: string;
  bin: string;
  launcher: string;
  data: string;
  configFile: string;
  secrets: string;
  database: string;
  databaseRevisions: string;
  backups: string;
  configurationRevisions: string;
  plannerSessions: string;
  executionWorkspaces: string;
  generatedAgentRuntime: string;
  generatedCurrent: string;
  upgradeJournals: string;
  attempts: string;
  logs: string;
  cache: string;
}

export interface AnyFusionReleasePaths {
  releaseRoot: string;
  dist: string;
  nodeModules: string;
  packageJson: string;
  manifest: string;
  plannerRoot: string;
}

export function resolveAnyFusionRoot(
  userHome?: string,
  envInstallRoot?: string,
): string {
  const resolvedHome = userHome ?? homedir();
  const rootOverride = arguments.length >= 2
    ? envInstallRoot
    : userHome === undefined
      ? process.env.ANYFUSION_INSTALL_ROOT
      : undefined;
  if (rootOverride && rootOverride.trim().length > 0) {
    return resolve(rootOverride);
  }

  return resolve(resolvedHome, '.anyfusion');
}

export function resolveAnyFusionPaths(
  userHome?: string,
  envInstallRoot?: string,
): AnyFusionPaths {
  const resolvedHome = userHome ?? homedir();
  const root = arguments.length >= 2
    ? resolveAnyFusionRoot(resolvedHome, envInstallRoot)
    : userHome === undefined
      ? resolveAnyFusionRoot()
      : resolveAnyFusionRoot(resolvedHome);
  const app = resolve(root, 'app');
  const config = resolve(root, 'config');
  const data = resolve(root, 'data');
  const generated = resolve(root, 'generated');
  const tmp = resolve(root, 'tmp');

  return {
    root,
    appCurrent: resolve(app, 'current'),
    releases: resolve(app, 'releases'),
    bin: resolve(root, 'bin'),
    launcher: resolve(resolvedHome, '.local', 'bin', 'anyfusion'),
    data,
    configFile: resolve(config, 'active', 'config.yaml'),
    secrets: resolve(config, 'secrets'),
    database: resolve(data, 'metaclaw.db'),
    databaseRevisions: resolve(data, 'database-revisions'),
    backups: resolve(data, 'backups'),
    configurationRevisions: resolve(config, 'revisions'),
    plannerSessions: resolve(data, 'planner-sessions'),
    executionWorkspaces: resolve(data, 'execution-workspaces'),
    generatedAgentRuntime: resolve(generated, 'agent-runtime'),
    generatedCurrent: resolve(generated, 'current'),
    upgradeJournals: resolve(root, 'upgrade-journals'),
    attempts: resolve(tmp, 'attempts'),
    logs: resolve(root, 'logs'),
    cache: resolve(root, 'cache'),
  };
}

export function resolveReleasePaths(root: string, releaseId: string): AnyFusionReleasePaths {
  const releaseRoot = resolve(root, 'app', 'releases', releaseId);

  return {
    releaseRoot,
    dist: resolve(releaseRoot, 'dist'),
    nodeModules: resolve(releaseRoot, 'node_modules'),
    packageJson: resolve(releaseRoot, 'package.json'),
    manifest: resolve(releaseRoot, 'release-manifest.json'),
    plannerRoot: resolve(releaseRoot, 'planner'),
  };
}
