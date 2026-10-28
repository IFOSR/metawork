import { publicText } from '../utils/public-text.js';
import { stringArg, type CommandContext, type CommandResult, type ResolvedCommandArgs } from './catalog.js';

export async function serviceCommand(args: ResolvedCommandArgs, context: CommandContext,
  operation: 'start' | 'status' | 'logs' | 'stop' | 'restart'): Promise<CommandResult> {
  try {
    const target = stringArg(args, 'target');
    const port = context.taskControl;
    const taskId = operation === 'start' ? target : await port.localServiceTaskId?.(target);
    const task = taskId ? context.taskEngine.getTaskRepo().findById(taskId) : null;
    if (!task || (context.conversationId && task.conversationId !== context.conversationId)) {
      throw new Error('当前会话中没有该服务任务');
    }
    const result = operation === 'status' || operation === 'logs'
      ? await port.readLocalService?.(target, operation === 'logs')
      : await port.manageLocalService?.(task.id, operation, operation === 'start' ? undefined : target);
    if (result === undefined) throw new Error('当前 Runtime 未配置受管服务');
    if (typeof result === 'string') return { type: 'text', content: result };
    // A discovered run has no declared port, so an empty address is reported as
    // absent instead of printing a meaningless URL.
    const targetLine = result.target
      ? `\n运行目标：${result.target.targetPath || 'Workspace 根目录'}（${result.target.source}）`
      : '';
    return { type: 'text', content: `服务 ${result.serviceId}：${result.state}\n${result.message ?? ''}`
      + `${targetLine}${result.url ? `\n访问地址：${result.url}` : ''}` };
  } catch (error) {
    return { type: 'text', content: publicText(`服务操作失败：${error instanceof Error ? error.message : '请查询服务状态后重试'}`) };
  }
}
