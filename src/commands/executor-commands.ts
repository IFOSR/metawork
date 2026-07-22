import type { AgentClass, AgentClassRiskLevel } from '../core/types.js';
import { PERMISSION_PROFILE_IDS, type PermissionProfileId } from '../resource/index.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { isBuiltinExecutorName } from '../executor/builtin-executor-catalog.js';
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
): AgentClass {
  const risk = (parseScalarArg(args, '--risk') ?? existing?.riskLevel ?? 'medium') as AgentClassRiskLevel;
  const permissionProfileId = (parseScalarArg(args, '--permission-profile')
    ?? existing?.permissionProfileId
    ?? null) as PermissionProfileId | null;
  if (permissionProfileId && !PERMISSION_PROFILE_IDS.includes(permissionProfileId)) {
    throw new Error(`Unknown permission profile: ${permissionProfileId}`);
  }
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
    harness: existing?.harness ?? 'cli',
    model: existing?.model ?? null,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? [],
    plugins: existing?.plugins ?? [],
    runtimeCommand: parseScalarArg(args, '--command') ?? existing?.runtimeCommand ?? null,
    runtimeArgs: parseScalarArg(args, '--args') ? parseRuntimeArgs(parseScalarArg(args, '--args')) : existing?.runtimeArgs ?? [],
    runtimeCheckCommand: parseScalarArg(args, '--check') ?? existing?.runtimeCheckCommand ?? null,
    executionImageRef: parseScalarArg(args, '--image') ?? existing?.executionImageRef ?? null,
    resolvedImageId: parseScalarArg(args, '--image-id') ?? existing?.resolvedImageId ?? null,
    permissionProfileId,
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
  return `  ${agentClass.name} kind=${agentClass.kind} domains=${agentClass.domains.join(',') || '-'} capabilities=${agentClass.capabilities.join(',') || '-'} intents=${intents || '-'} risk=${agentClass.riskLevel} ${runtime}`;
}

export const executorCommand: CommandHandler = {
  name: 'executor',
  aliases: [],
  description: 'AgentClass/WorkUnit management implementation for the command catalog.',
  async execute(args, context) {
    const action = args[0] ?? 'list';
    const agentClassRepo = new AgentClassRepo(context.db);
    const workUnitRepo = new WorkUnitRepo(context.db);
    if (action === 'register') {
      const name = args[1];
      const optionArgs = args.slice(2);
      if (!name) {
        return {
          type: 'text',
          content: [
            'Enter the AgentClass registration wizard with /executor register wizard',
            '',
            'One-line usage:',
            '/executor register <name> --image <ref> --image-id <sha256:id> --permission-profile restricted-custom --command <cmd> --args "exec --prompt {prompt}" [--domains a,b] [--capabilities a,b]',
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
      if (isBuiltinExecutorName(name)) {
        return { type: 'text', content: `Cannot register or update canonical Executor AgentClass: ${name}` };
      }
      const agentClass = buildAgentClassFromArgs(name, optionArgs, agentClassRepo.findByName(name));
      if (!agentClass.executionImageRef || !agentClass.resolvedImageId || !agentClass.permissionProfileId) {
        return { type: 'text', content: 'Custom Executor requires --image, --image-id and --permission-profile.' };
      }
      if (!/^sha256:[a-f0-9]{64}$/u.test(agentClass.resolvedImageId)) {
        return { type: 'text', content: 'Custom Executor --image-id must be an immutable sha256:<64 hex> image ID.' };
      }
      agentClassRepo.upsert(agentClass);
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
      if (isBuiltinExecutorName(name)) {
        return { type: 'text', content: `Cannot unregister canonical Executor AgentClass: ${name}` };
      }
      const existing = agentClassRepo.findByName(name);
      if (!existing) {
        return { type: 'text', content: `Executor AgentClass is not registered: ${name}` };
      }
      if (workUnitRepo.findAll().some(unit => unit.agentClassName === name)) {
        return { type: 'text', content: `Cannot unregister AgentClass with WorkUnits: ${name}` };
      }
      agentClassRepo.delete(name);
      return { type: 'text', content: `Unregistered Executor AgentClass: ${name}` };
    }

    if (action === 'list') {
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

    return { type: 'text', content: `Unknown executor operation: ${action}` };
  },
};
