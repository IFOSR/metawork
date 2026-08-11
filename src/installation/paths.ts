import { homedir } from 'os';
import { resolve } from 'path';

export interface AnyFusionPaths {
  root: string;
  appCurrent: string;
  releases: string;
  data: string;
  configFile: string;
  secrets: string;
  database: string;
  configurationRevisions: string;
  plannerSessions: string;
  executionWorkspaces: string;
  generatedAgentRuntime: string;
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
  userHome = homedir(),
  envInstallRoot = process.env.ANYFUSION_INSTALL_ROOT,
): string {
  if (envInstallRoot && envInstallRoot.trim().length > 0) {
    return resolve(envInstallRoot);
  }

  return resolve(userHome, '.anyfusion');
}

export function resolveAnyFusionPaths(
  userHome = homedir(),
  envInstallRoot = process.env.ANYFUSION_INSTALL_ROOT,
): AnyFusionPaths {
  const root = resolveAnyFusionRoot(userHome, envInstallRoot);
  const app = resolve(root, 'app');
  const config = resolve(root, 'config');
  const data = resolve(root, 'data');
  const generated = resolve(root, 'generated');
  const tmp = resolve(root, 'tmp');

  return {
    root,
    appCurrent: resolve(app, 'current'),
    releases: resolve(app, 'releases'),
    data,
    configFile: resolve(config, 'active', 'config.yaml'),
    secrets: resolve(config, 'secrets'),
    database: resolve(data, 'metaclaw.db'),
    configurationRevisions: resolve(config, 'revisions'),
    plannerSessions: resolve(data, 'planner-sessions'),
    executionWorkspaces: resolve(data, 'execution-workspaces'),
    generatedAgentRuntime: resolve(generated, 'agent-runtime'),
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
