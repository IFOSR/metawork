import type { AgentClass } from '../core/types.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import {
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

function formatAgentClass(agentClass: AgentClass, health: string): string {
  const list = (values: string[]) => values.join(', ') || '-';
  return [
    `  ${agentClass.name} kind=${agentClass.kind} health=${health}`,
    `    domains: ${list(agentClass.domains)}`,
    `    capabilities: ${list(agentClass.capabilities)}`,
    `    strengths: ${list(agentClass.strengths)}`,
    `    primary use cases: ${list(agentClass.primaryUseCases)}`,
  ].join('\n');
}

export async function listExecutors(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const agentClasses = new AgentClassRepo(context.db).findAll();
  if (agentClasses.length === 0) {
    return { type: 'text', content: 'No AgentClass records are registered.' };
  }
  const workUnits = new WorkUnitRepo(context.db).findAll();
  const statuses = new KernelExecutorStatusRepo(context.db);
  const configurationRevision = await context.readServices?.currentConfigurationRevision() ?? null;
  const revisionStatuses = configurationRevision
    ? new Map(statuses.list(configurationRevision).map(status => [status.agentClassName, status]))
    : new Map();
  return {
    type: 'text',
    content: [
      'Registered AgentClasses:',
      ...agentClasses.map(agentClass => formatAgentClass(
        agentClass,
        configurationRevision
          ? revisionStatuses.get(agentClass.name)?.classHealth ?? 'unverified'
          : 'unavailable (configuration revision not provided)',
      )),
      `Health configuration revision: ${configurationRevision ?? 'unavailable'}`,
      '',
      `WorkUnits: ${workUnits.map(unit => `${unit.id}:${unit.agentClassName}:${unit.state}`).join(', ') || '-'}`,
    ].join('\n'),
  };
}

export async function refreshExecutors(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.refreshExecutors) {
    return { type: 'text', content: 'Executor recovery refresh is not available in this host.' };
  }
  const configurationRevision = await context.readServices?.currentConfigurationRevision() ?? null;
  if (!configurationRevision) {
    return {
      type: 'text',
      content: 'Executor recovery refresh requires an explicit configuration revision from the host.',
    };
  }
  const target = stringArg(args, 'executorName');
  const report = await context.refreshExecutors(target && target !== 'all' ? [target] : undefined);
  if (
    'configurationRevision' in report
    && report.configurationRevision !== configurationRevision
  ) {
    throw new Error(
      `Executor recovery refresh revision changed from ${configurationRevision} to ${String(report.configurationRevision)}`,
    );
  }
  return {
    type: 'text',
    content: [
      `Configuration revision: ${configurationRevision}`,
      `Recovery refresh checked: ${report.checked.join(', ') || '-'}`,
      `Recovered: ${report.recovered.join(', ') || '-'}`,
      `Still error: ${report.stillError.join(', ') || '-'}`,
      `Skipped (not error/unknown): ${report.skipped.join(', ') || '-'}`,
    ].join('\n'),
  };
}
