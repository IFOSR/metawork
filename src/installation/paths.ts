import { homedir } from 'os';
import { resolve } from 'path';
import {
  PRODUCT_ENVIRONMENT,
  resolveProductEnvironment,
} from './product-environment.js';

export interface MetaWorkPaths {
  root: string;
  accountsRoot: string;
  appCurrent: string;
  releases: string;
  bin: string;
  launcher: string;
  anyFusionLauncher: string;
  metaclawLauncher: string;
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

export interface MetaWorkReleasePaths {
  releaseRoot: string;
  dist: string;
  nodeModules: string;
  packageJson: string;
  manifest: string;
  plannerRoot: string;
}

export type AnyFusionPaths = MetaWorkPaths;
export type AnyFusionReleasePaths = MetaWorkReleasePaths;

export function resolveMetaWorkRoot(
  userHome?: string,
  envInstallRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolvedHome = userHome ?? homedir();
  const explicitRoot = envInstallRoot?.trim();
  const rootOverride = explicitRoot || (
    arguments.length >= 3 || userHome === undefined
      ? resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.installRoot)
      : undefined
  );
  if (rootOverride && rootOverride.trim().length > 0) {
    return resolve(rootOverride);
  }

  return resolve(resolvedHome, '.metawork');
}

export function resolveMetaWorkPaths(
  userHome?: string,
  envInstallRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): MetaWorkPaths {
  const resolvedHome = userHome ?? homedir();
  const root = resolveMetaWorkRoot(resolvedHome, envInstallRoot, (
    arguments.length >= 3 || userHome === undefined ? env : {}
  ));
  const app = resolve(root, 'app');
  const config = resolve(root, 'config');
  const data = resolve(root, 'data');
  const generated = resolve(root, 'generated');
  const tmp = resolve(root, 'tmp');

  return {
    root,
    accountsRoot: resolve(root, 'accounts'),
    appCurrent: resolve(app, 'current'),
    releases: resolve(app, 'releases'),
    bin: resolve(root, 'bin'),
    launcher: resolve(resolvedHome, '.local', 'bin', 'metawork'),
    anyFusionLauncher: resolve(resolvedHome, '.local', 'bin', 'anyfusion'),
    metaclawLauncher: resolve(resolvedHome, '.local', 'bin', 'metaclaw'),
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

export function resolveAnyFusionRoot(
  userHome?: string,
  envInstallRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (arguments.length <= 1) return resolveMetaWorkRoot(userHome);
  if (arguments.length === 2) return resolveMetaWorkRoot(userHome, envInstallRoot);
  return resolveMetaWorkRoot(userHome, envInstallRoot, env);
}

export function resolveAnyFusionPaths(
  userHome?: string,
  envInstallRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): AnyFusionPaths {
  if (arguments.length <= 1) return resolveMetaWorkPaths(userHome);
  if (arguments.length === 2) return resolveMetaWorkPaths(userHome, envInstallRoot);
  return resolveMetaWorkPaths(userHome, envInstallRoot, env);
}

export function resolveReleasePaths(root: string, releaseId: string): MetaWorkReleasePaths {
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
