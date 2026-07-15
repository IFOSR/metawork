import { dump } from 'js-yaml';
import type { CommandHandler, CommandContext, CommandResult } from './router.js';

export const dashboardCommand: CommandHandler = {
  name: 'dashboard',
  aliases: [],
  description: '显示任务盘面',
  async execute(args, context) {
    const dashboard = context.orchestration.getDashboard();

    const lines = [
      '┌─ Metaclaw 任务盘面 ─────────────────────────────┐',
      `│ 活跃: ${dashboard.summary.active}  阻塞: ${dashboard.summary.blocked}  暂停: ${dashboard.summary.parked}  完成: ${dashboard.summary.done}`,
      '│',
    ];

    if (dashboard.priorityTask) {
      lines.push('│ 建议优先处理：');
      lines.push(`│   #${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
      dashboard.priorityTask.reasons.forEach(r => lines.push(`│     → ${r}`));
      lines.push('│');
    }

    if (dashboard.blockedTasks.length > 0) {
      lines.push('│ 当前卡住：');
      dashboard.blockedTasks.forEach(t => {
        lines.push(`│   #${t.id} ${t.title}`);
        lines.push(`│     → ${t.blockReason}`);
      });
      lines.push('│');
    }

    if (dashboard.readyTasks.length > 0) {
      lines.push('│ 可以处理：');
      dashboard.readyTasks.slice(0, 3).forEach(t => {
        lines.push(`│   #${t.id} ${t.title}`);
      });
    }

    lines.push('└──────────────────────────────────────────────────┘');

    return { type: 'dashboard', content: lines.join('\n'), data: dashboard };
  },
};

export const attachCommand: CommandHandler = {
  name: 'attach',
  aliases: [],
  description: '命令目录内部的任务资源关联实现。',
  async execute(args, context) {
    if (args.length === 0) {
      return { type: 'text', content: '用法: /task attach <taskId> <资源...>' };
    }

    const explicitTask = context.taskEngine['taskRepo'].findById(args[0]);
    const targetTaskId = explicitTask?.id ?? context.currentTaskId;
    const resourceArgs = explicitTask ? args.slice(1) : args;

    if (!targetTaskId) {
      return { type: 'text', content: '请显式指定任务：/task attach <taskId> <资源...>' };
    }

    if (resourceArgs.length === 0) {
      return { type: 'text', content: '用法: /task attach <taskId> <资源...>' };
    }

    const attachedResources: string[] = [];
    for (const resourcePath of resourceArgs) {
      context.taskEngine.attachResource(targetTaskId, resourcePath);
      attachedResources.push(resourcePath);
    }

    const targetTask = context.taskEngine['taskRepo'].findById(targetTaskId)!;
    const summaryLine = `已关联 ${attachedResources.length} 个文件到任务 #${targetTaskId}: ${attachedResources.join(', ')}`;

    if (targetTask.status === 'blocked') {
      return {
        type: 'text',
        content: `${summaryLine}\n任务 #${targetTaskId} 当前仍为 BLOCKED，可继续执行 /task unblock ${targetTaskId}`,
      };
    }

    return { type: 'text', content: summaryLine };
  },
};

export const configCommand: CommandHandler = {
  name: 'config',
  aliases: [],
  description: '查看当前配置',
  async execute(args, context) {
    return { type: 'text', content: dump(context.config).trim() };
  },
};

export const exitCommand: CommandHandler = {
  name: 'exit',
  aliases: [],
  description: '退出 Metaclaw',
  async execute() {
    return { type: 'exit', content: '再见 👋' };
  },
};
