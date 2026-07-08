import type { AgentClass, AgentClassAvailability, AgentClassRiskLevel } from '../core/types.js';
import { ensureExecutorWorkUnit, seedDefaultAgentClasses, seedDefaultWorkUnits } from '../executor/agent-class-seeder.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import type { CommandHandler } from './router.js';

function parseListArg(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : '';
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

function parseScalarArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseRuntimeArgs(value?: string): string[] {
  if (!value) return [];
  return value.split(/\s+/).map(item => item.trim()).filter(Boolean);
}

function buildAgentClassFromArgs(
  name: string,
  args: string[],
  existing?: AgentClass | null,
  availability: AgentClassAvailability = 'available',
): AgentClass {
  const risk = (parseScalarArg(args, '--risk') ?? existing?.riskLevel ?? 'medium') as AgentClassRiskLevel;
  return {
    name,
    kind: 'executor',
    domains: parseListArg(args, '--domains').length > 0 ? parseListArg(args, '--domains') : existing?.domains ?? [],
    capabilities: parseListArg(args, '--capabilities').length > 0 ? parseListArg(args, '--capabilities') : existing?.capabilities ?? [],
    inputTypes: parseListArg(args, '--inputs').length > 0 ? parseListArg(args, '--inputs') : existing?.inputTypes ?? ['text'],
    outputTypes: parseListArg(args, '--outputs').length > 0 ? parseListArg(args, '--outputs') : existing?.outputTypes ?? ['markdown'],
    strengths: parseListArg(args, '--strengths').length > 0 ? parseListArg(args, '--strengths') : existing?.strengths ?? [],
    weaknesses: parseListArg(args, '--weaknesses').length > 0 ? parseListArg(args, '--weaknesses') : existing?.weaknesses ?? [],
    primaryUseCases: parseListArg(args, '--primary-use-cases').length > 0
      ? parseListArg(args, '--primary-use-cases')
      : existing?.primaryUseCases ?? [],
    avoidUseCases: parseListArg(args, '--avoid-use-cases').length > 0
      ? parseListArg(args, '--avoid-use-cases')
      : existing?.avoidUseCases ?? [],
    intentAffinity: existing?.intentAffinity ?? {},
    riskLevel: risk,
    availability,
    historicalSuccess: Number.parseFloat(parseScalarArg(args, '--success') ?? String(existing?.historicalSuccess ?? 0.5)),
    harness: existing?.harness ?? 'cli',
    model: existing?.model ?? null,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? [],
    plugins: existing?.plugins ?? [],
    runtimeCommand: parseScalarArg(args, '--command') ?? existing?.runtimeCommand ?? null,
    runtimeArgs: parseScalarArg(args, '--args') ? parseRuntimeArgs(parseScalarArg(args, '--args')) : existing?.runtimeArgs ?? [],
    runtimeCheckCommand: parseScalarArg(args, '--check') ?? existing?.runtimeCheckCommand ?? null,
    projectUrl: parseScalarArg(args, '--project-url') ?? existing?.projectUrl ?? null,
  };
}

function formatAgentClass(agentClass: AgentClass): string {
  const intents = Object.entries(agentClass.intentAffinity ?? {})
    .map(([intent, score]) => `${intent}:${score}`)
    .join(',');
  const runtime = agentClass.runtimeCommand
    ? `runtime=${agentClass.runtimeCommand} ${(agentClass.runtimeArgs ?? []).join(' ')}`.trim()
    : 'runtime=-';
  return `  ${agentClass.name} kind=${agentClass.kind} status=${agentClass.availability} domains=${agentClass.domains.join(',') || '-'} capabilities=${agentClass.capabilities.join(',') || '-'} intents=${intents || '-'} risk=${agentClass.riskLevel} success=${agentClass.historicalSuccess} ${runtime}`;
}

export const executorCommand: CommandHandler = {
  name: 'executor',
  aliases: ['executors'],
  description: 'AgentClass/WorkUnit management: /executor [list|register|unregister|route-feedback]',
  async execute(args, context) {
    const action = args[0] ?? 'list';
    const agentClassRepo = new AgentClassRepo(context.db);
    const workUnitRepo = new WorkUnitRepo(context.db);
    seedDefaultAgentClasses(agentClassRepo, {
      defaultExecutorName: context.executor.name,
    });
    seedDefaultWorkUnits(workUnitRepo, { executorAgentClassName: context.executor.name });

    if (action === 'register' || (action === 'profile' && args[1] === 'upsert')) {
      const name = action === 'register' ? args[1] : args[2];
      const optionArgs = action === 'register' ? args.slice(2) : args.slice(3);
      if (!name) {
        return {
          type: 'text',
          content: [
            'Enter the AgentClass registration wizard with /executor register wizard',
            '',
            'One-line usage:',
            '/executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--project-url <url>] [--domains a,b] [--capabilities a,b]',
          ].join('\n'),
        };
      }
      if (name === 'wizard') {
        return {
          type: 'text',
          content: 'Executor AgentClass registration wizard started. Answer the prompts, or type cancel.',
          data: { executorRegisterWizard: true },
        };
      }
      agentClassRepo.upsert(buildAgentClassFromArgs(name, optionArgs, agentClassRepo.findByName(name), 'available'));
      ensureExecutorWorkUnit(workUnitRepo, name);
      return {
        type: 'text',
        content: action === 'register'
          ? `Registered Executor AgentClass: ${name}`
          : `Updated Executor AgentClass: ${name}`,
      };
    }

    if (action === 'unregister') {
      const name = args[1];
      if (!name) {
        return { type: 'text', content: 'Usage: /executor unregister <name>' };
      }
      const existing = agentClassRepo.findByName(name);
      if (!existing) {
        return { type: 'text', content: `Executor AgentClass is not registered: ${name}` };
      }
      agentClassRepo.upsert({ ...existing, availability: 'unavailable' });
      return { type: 'text', content: `Unregistered Executor AgentClass: ${name}` };
    }

    if (action === 'list' || action === 'profiles') {
      const agentClasses = agentClassRepo.findAll();
      if (agentClasses.length === 0) {
        return { type: 'text', content: 'No AgentClass records are registered.' };
      }
      const workUnits = workUnitRepo.findAll();
      return {
        type: 'text',
        content: [
          `Registered AgentClasses (default executor: ${context.executor.name}):`,
          ...agentClasses.map(formatAgentClass),
          '',
          `WorkUnits: ${workUnits.map(unit => `${unit.id}:${unit.agentClassName}:${unit.state}`).join(', ') || '-'}`,
          '',
          'Commands: /executor register wizard',
          'Commands: /executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--domains a,b] [--capabilities a,b]',
          'Commands: /executor unregister <name>',
        ].join('\n'),
      };
    }

    if (action === 'route-feedback') {
      const events = new TaskEventRepo(context.db).listRecent();
      if (events.length === 0) {
        return { type: 'text', content: 'No planner task events recorded yet.' };
      }
      return {
        type: 'text',
        content: `Planner Task Events:\n${events.map(event =>
          `  #${event.id} ${event.eventType} task=${event.taskId} subtask=${event.subtaskId ?? '-'} ${event.message}`
        ).join('\n')}`,
      };
    }

    return { type: 'text', content: `Unknown executor operation: ${action}` };
  },
};
