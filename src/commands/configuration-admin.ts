// Executes Admin CLI commands against the ConfigurationService projection.
// Read-only commands resolve the active snapshot; write commands dispatch through
// the ConfigurationService write surface rather than YAML/env/SQLite directly.
import type { AdminCommand } from '../cli/admin-args.js';
import type { AnyFusionConfigurationV2, ConfigurationSnapshot } from '../configuration/types.js';
import { validateConfigurationCandidate } from '../configuration/configuration-validator.js';

export type ConfigurationMutationResult =
  | { ok: true; revisionId: string }
  | { ok: false; code: string; activeRevisionId?: string | null; issues?: string[] };

export interface ConfigurationAdminDeps {
  getActiveSnapshot(): Promise<ConfigurationSnapshot>;
  rollback?(targetRevisionId: string): Promise<ConfigurationMutationResult>;
  listRevisions?(): Promise<string[]>;
  getSnapshot?(revisionId: string): Promise<ConfigurationSnapshot>;
  activate?(config: AnyFusionConfigurationV2): Promise<ConfigurationMutationResult>;
}

export async function runConfigurationAdmin(
  command: AdminCommand,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  switch (command.kind) {
    case 'status':
      return formatStatus(await deps.getActiveSnapshot());
    case 'config':
      return runConfig(command, deps);
    case 'provider':
      return runProvider(command, await deps.getActiveSnapshot(), deps);
    case 'model':
      return runModel(command, await deps.getActiveSnapshot(), deps);
    case 'planner':
      return runPlanner(command.subcommand, await deps.getActiveSnapshot());
    case 'executor':
      return runExecutor(command, await deps.getActiveSnapshot(), deps);
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

function formatMutationResult(result: ConfigurationMutationResult): string[] {
  if (result.ok) return [`activated: ${result.revisionId}`];
  return [
    `rejected: ${result.code}`,
    ...(result.activeRevisionId != null ? [`activeRevision: ${result.activeRevisionId}`] : []),
    ...(result.issues ?? []).map(issue => `- ${issue}`),
  ];
}

async function runConfig(
  command: Extract<AdminCommand, { kind: 'config' }>,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  const snapshot = await deps.getActiveSnapshot();
  switch (command.subcommand) {
    case 'show':
      return [JSON.stringify(snapshot.config, null, 2)];
    case 'validate': {
      const result = validateConfigurationCandidate(snapshot.config);
      if (result.ok) return ['configuration is valid'];
      return [
        'configuration is invalid:',
        ...result.issues.map(issue => `- ${issue.path || '(root)'}: ${issue.message}`),
      ];
    }
    case 'history': {
      if (!deps.listRevisions) return ['config history requires the write ConfigurationService surface'];
      const revisions = await deps.listRevisions();
      const active = snapshot.revisionId;
      return revisions.map(revision => (revision === active ? `${revision} (active)` : revision));
    }
    case 'diff': {
      if (!command.targetRevisionId) return ['config diff requires a target revision id'];
      if (!deps.getSnapshot) return ['config diff requires the write ConfigurationService surface'];
      const target = await deps.getSnapshot(command.targetRevisionId);
      return [
        target.contentHash === snapshot.contentHash
          ? 'no differences'
          : `different: ${command.targetRevisionId} (${target.contentHash}) vs ${snapshot.revisionId} (${snapshot.contentHash})`,
      ];
    }
    case 'rollback': {
      if (!command.targetRevisionId) return ['config rollback requires a target revision id'];
      if (!deps.rollback) return ['config rollback requires the write ConfigurationService surface'];
      return formatMutationResult(await deps.rollback(command.targetRevisionId));
    }
  }
}

async function runProvider(
  command: Extract<AdminCommand, { kind: 'provider' }>,
  snapshot: ConfigurationSnapshot,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  if (command.subcommand === 'list') {
    return Object.keys(snapshot.config.providers).sort();
  }
  if (!deps.activate || !command.id) {
    return [`provider ${command.subcommand} requires the write ConfigurationService surface`];
  }
  if (command.subcommand === 'remove') {
    if (!snapshot.config.providers[command.id]) return [`provider ${command.id} not found`];
    const providers = { ...snapshot.config.providers };
    delete providers[command.id];
    return formatMutationResult(await deps.activate({ ...snapshot.config, providers }));
  }
  return [`provider ${command.subcommand} requires additional configuration input`];
}

async function runModel(
  command: Extract<AdminCommand, { kind: 'model' }>,
  snapshot: ConfigurationSnapshot,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  if (command.subcommand === 'list') {
    return Object.keys(snapshot.config.models).sort();
  }
  if (!deps.activate || !command.id) {
    return [`model ${command.subcommand} requires the write ConfigurationService surface`];
  }
  if (command.subcommand === 'remove') {
    if (!snapshot.config.models[command.id]) return [`model ${command.id} not found`];
    const models = { ...snapshot.config.models };
    delete models[command.id];
    return formatMutationResult(await deps.activate({ ...snapshot.config, models }));
  }
  return [`model ${command.subcommand} requires additional configuration input`];
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

async function runExecutor(
  command: Extract<AdminCommand, { kind: 'executor' }>,
  snapshot: ConfigurationSnapshot,
  deps: ConfigurationAdminDeps,
): Promise<string[]> {
  if (command.subcommand === 'list') {
    return Object.entries(snapshot.config.agentClasses)
      .filter(([, agentClass]) => agentClass.kind === 'executor')
      .map(([name, agentClass]) => `${name} (${agentClass.enabled ? 'enabled' : 'disabled'})`)
      .sort();
  }
  if (!deps.activate || !command.id) {
    return [`executor ${command.subcommand} requires the write ConfigurationService surface`];
  }
  const agentClasses = { ...snapshot.config.agentClasses };
  const existing = agentClasses[command.id];
  if (!existing) return [`executor ${command.id} not found`];
  if (command.subcommand === 'remove') {
    delete agentClasses[command.id];
  } else if (command.subcommand === 'enable') {
    agentClasses[command.id] = { ...existing, enabled: true };
  } else if (command.subcommand === 'disable') {
    agentClasses[command.id] = { ...existing, enabled: false };
  } else {
    return [`executor ${command.subcommand} requires additional configuration input`];
  }
  return formatMutationResult(await deps.activate({ ...snapshot.config, agentClasses }));
}
