import { dump } from 'js-yaml';
import {
  stringArg,
  stringListArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';
import { readTaskDashboardFacts } from './task-dashboard-facts.js';
import { buildTaskDashboard, formatTaskDashboard } from './task-dashboard-view.js';

export async function showDashboard(_args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  // One vocabulary (ADR-0049) and one capacity fact (ADR-0037): the model is
  // built from the canonical TaskView plus the account-scoped execution slots.
  const model = buildTaskDashboard(readTaskDashboardFacts(context));
  return { type: 'dashboard', content: formatTaskDashboard(model), payload: model };
}

export async function attachTaskResources(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const resources = stringListArg(args, 'resources');

  if (resources.length === 0) {
    return { type: 'text', content: '用法: /task attach <taskId> <资源...>' };
  }

  for (const resourcePath of resources) {
    context.taskEngine.attachResource(taskId, resourcePath);
  }

  const targetTask = context.taskEngine.getTaskRepo().findById(taskId)!;
  const summaryLine = `已关联 ${resources.length} 个文件到任务 #${taskId}: ${resources.join(', ')}`;

  if (targetTask.status === 'needs_action') {
    return {
      type: 'text',
      content: `${summaryLine}\n任务 #${taskId} 仍需要处理，可继续执行 /task resume ${taskId}`,
    };
  }

  return { type: 'text', content: summaryLine };
}

export async function showConfig(_args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  return { type: 'text', content: dump(context.config).trim() };
}

export async function exitSession(): Promise<CommandResult> {
  return { type: 'exit', content: '再见 👋' };
}
