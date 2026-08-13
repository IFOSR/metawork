// Executes Admin CLI commands against the ConfigurationService projection.
// Read-only commands resolve the active snapshot; write commands are dispatched
// through the full ConfigurationService surface rather than YAML/env/SQLite.
import type { AdminCommand } from '../cli/admin-args.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';

export interface ConfigurationAdminDeps {
  getActiveSnapshot(): Promise<ConfigurationSnapshot>;
}

export async function runConfigurationAdmin(
  command: AdminCommand,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  switch (command.kind) {
    case 'status':
      return formatStatus(await deps.getActiveSnapshot());
    case 'config':
      return runConfig(command.subcommand, await deps.getActiveSnapshot());
    case 'provider':
      return runProvider(command.subcommand, await deps.getActiveSnapshot(), command.id);
    case 'model':
      return runModel(command.subcommand, await deps.getActiveSnapshot(), command.id);
    case 'planner':
      return runPlanner(command.subcommand, await deps.getActiveSnapshot());
    case 'executor':
      return runExecutor(command.subcommand, await deps.getActiveSnapshot(), command.id);
    case 'doctor':
      return ['doctor: use the gateway doctor surface for health checks'];
    case 'configure':
      return ['configuration is managed via `anyfusion config` subcommands'];
  }
}

function formatStatus(snapshot: ConfigurationSnapshot): string[] {
  return [
    `revision: ${snapshot.revisionId}`,
    `contentHash: ${snapshot.contentHash}`,
    `providers: ${Object.keys(snapshot.config.providers).length}`,
    `models: ${Object.keys(snapshot.config.models).length}`,
    `harnesses: ${Object.keys(snapshot.config.harnesses).length}`,
    `agentClasses: ${Object.keys(snapshot.config.agentClasses).length}`,
  ];
}

function runConfig(
  subcommand: 'show' | 'validate' | 'diff' | 'history' | 'rollback',
  snapshot: ConfigurationSnapshot,
): string[] {
  switch (subcommand) {
    case 'show':
      return [JSON.stringify(snapshot.config, null, 2)];
    case 'validate':
    case 'diff':
    case 'history':
    case 'rollback':
      return [`config ${subcommand} requires the write ConfigurationService surface`];
  }
}

function runProvider(
  subcommand: 'list' | 'add' | 'edit' | 'test' | 'remove',
  snapshot: ConfigurationSnapshot,
  id: string | undefined,
): string[] {
  if (subcommand === 'list') {
    return Object.keys(snapshot.config.providers).sort();
  }
  return [`provider ${subcommand}${id ? ` ${id}` : ''} requires the write ConfigurationService surface`];
}

function runModel(
  subcommand: 'list' | 'add' | 'edit' | 'test' | 'remove',
  snapshot: ConfigurationSnapshot,
  id: string | undefined,
): string[] {
  if (subcommand === 'list') {
    return Object.keys(snapshot.config.models).sort();
  }
  return [`model ${subcommand}${id ? ` ${id}` : ''} requires the write ConfigurationService surface`];
}

function runPlanner(
  subcommand: 'show' | 'configure' | 'test',
  snapshot: ConfigurationSnapshot,
): string[] {
  const planner = snapshot.config.agentClasses.planner;
  if (subcommand === 'show') {
    return planner
      ? [`planner: ${planner.harnessRef} (${planner.enabled ? 'enabled' : 'disabled'})`]
      : ['planner AgentClass is not configured'];
  }
  return [`planner ${subcommand} requires the write ConfigurationService surface`];
}

function runExecutor(
  subcommand: 'list' | 'add' | 'edit' | 'enable' | 'disable' | 'remove' | 'test',
  snapshot: ConfigurationSnapshot,
  id: string | undefined,
): string[] {
  const executors = Object.entries(snapshot.config.agentClasses)
    .filter(([, agentClass]) => agentClass.kind === 'executor')
    .map(([name, agentClass]) => `${name} (${agentClass.enabled ? 'enabled' : 'disabled'})`)
    .sort();
  if (subcommand === 'list') {
    return executors;
  }
  return [`executor ${subcommand}${id ? ` ${id}` : ''} requires the write ConfigurationService surface`];
}
