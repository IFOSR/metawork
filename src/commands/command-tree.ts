import { serviceCommand } from './service-commands.js';
import type { TaskStatus } from '../core/types.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import {
  CommandCatalog,
  stringArg,
  type CommandAction,
  type CommandArgumentSpec,
  type CommandCompletionContext,
  type CommandNode,
  type CommandOptionSpec,
} from './catalog.js';
import {
  acceptPartialResult,
  acceptResult,
  retryResult,
  retryRemainingWork,
  blockTask,
  cancelSubtasks,
  cancelTask,
  clearTasks,
  listTasks,
  pauseTask,
  rebuildTaskIndex,
  searchTaskIndex,
  resumeTask,
  showTask,
  unblockTask,
} from './task-commands.js';
import {
  listExecutors,
  refreshExecutors,
} from './executor-commands.js';
import { showExecutorProfile } from './profile-commands.js';
import { attachTaskResources, exitSession, showConfig, showDashboard } from './global-commands.js';

interface ActionInput {
  name: string;
  summary: string;
  effect: string;
  usage: string;
  examples?: string[];
  category?: 'common' | 'advanced';
  arguments?: CommandArgumentSpec[];
  options?: CommandOptionSpec[];
  builtin?: 'help';
  run?: CommandAction['execute'];
}

function action(input: ActionInput): CommandAction {
  return {
    kind: 'action',
    name: input.name,
    summary: input.summary,
    effect: input.effect,
    usages: [input.usage],
    examples: input.examples ?? [],
    category: input.category,
    arguments: input.arguments,
    options: input.options,
    builtin: input.builtin,
    execute: input.run,
  };
}

function taskReference(
  description: string,
  allowed?: TaskStatus[],
): CommandArgumentSpec {
  return {
    name: 'taskId',
    kind: 'reference',
    description,
    candidates: context => {
      const tasks = context.taskEngine.getTaskRepo().findAll()
        .filter(task => (!context.conversationId || task.conversationId === context.conversationId)
          && (!allowed || allowed.includes(task.status)))
        .sort((left, right) => {
          if (left.id === context.currentTaskId) return -1;
          if (right.id === context.currentTaskId) return 1;
          return right.updatedAt.localeCompare(left.updatedAt);
        });
      return tasks.map(task => ({
        value: task.id,
        label: `${task.title} · #${task.id}`,
        description: `最近更新：${task.updatedAt}`,
      }));
    },
    validate: (value, context) => {
      const task = context.taskEngine.getTaskRepo().findById(value);
      if (!task) return `任务不存在: ${value}`;
      if (allowed && !allowed.includes(task.status)) {
        return `任务 #${value} 当前为 ${task.status}，此操作要求状态为 ${allowed.join('|')}`;
      }
      return null;
    },
  };
}

function dynamicReference(
  name: string,
  description: string,
  values: (context: CommandCompletionContext) => Array<{ id: string; label: string; description: string }>,
  optional = false,
): CommandArgumentSpec {
  return {
    name,
    kind: 'reference',
    description,
    optional,
    candidates: context => values(context).map(item => ({
      value: item.id,
      label: item.label,
      description: item.description,
    })),
  };
}

const text = (name: string, description: string, optional = false): CommandArgumentSpec => ({
  name,
  kind: 'text',
  description,
  optional,
});

const rest = (name: string, description: string, optional = false): CommandArgumentSpec => ({
  name,
  kind: 'rest',
  description,
  optional,
});

const variadic = (name: string, description: string, optional = false): CommandArgumentSpec => ({
  name,
  kind: 'variadic',
  description,
  optional,
});

const enumArg = (name: string, description: string, values: string[], optional = false): CommandArgumentSpec => ({
  name,
  kind: 'enum',
  description,
  optional,
  values: values.map(value => ({ value, description: `${description}：${value}` })),
});

const option = (name: `--${string}`, description: string, value?: CommandArgumentSpec): CommandOptionSpec => ({
  name,
  description,
  value,
});

function taskNodes(): CommandNode[] {
  const operation = (
    name: string,
    summary: string,
    statuses: TaskStatus[],
    run: CommandAction['execute'],
    extraArguments: CommandArgumentSpec[] = [],
  ) => action({
    name,
    summary,
    effect: summary,
    usage: `/task ${name} <taskId>${extraArguments.length ? ` ${extraArguments.map(arg => arg.optional ? `[<${arg.name}...>]` : `<${arg.name}...>`).join(' ')}` : ''}`,
    arguments: [taskReference(`要${summary}的任务`, statuses), ...extraArguments],
    run,
  });

  return [
    action({ name: 'dashboard', summary: '显示任务盘面', effect: '读取任务统计、优先任务和需要处理的任务并展示盘面。', usage: '/task dashboard', category: 'advanced', run: showDashboard }),
    action({
      name: 'list', summary: '按统一状态查看任务', effect: '按等待中、执行中、需要处理、已结束显示任务。',
      usage: '/task list [all|waiting|executing|needs-action|finished]',
      arguments: [{
        ...enumArg('scope', '任务范围', ['all', 'waiting', 'executing', 'needs-action', 'finished'], true),
        values: [
          ...enumArg('scope', '任务范围', ['all', 'waiting', 'executing', 'needs-action', 'finished']).values!,
          ...['active', 'ready', 'parked', 'blocked', 'done'].map(value => ({ value, description: '旧筛选参数', hidden: true })),
        ],
      }],
      run: listTasks,
    }),
    action({
      name: 'show', summary: '查看任务详情', effect: '读取任务状态、快照、材料、结果和恢复建议。',
      usage: '/task show <taskId>', arguments: [taskReference('要查看的任务')],
      run: showTask,
    }),
    operation('pause', '暂停任务', ['running'], pauseTask),
    action({ name: 'block', summary: '标记为需要处理（兼容命令）', effect: '将运行中的任务标记为需要处理。', usage: '/task block <taskId> <reason...>', category: 'advanced', arguments: [taskReference('要标记的任务', ['running', 'queued']), rest('reason', '处理原因')], run: blockTask }),
    action({ name: 'resume', summary: '继续未完成部分', effect: '提交一次绑定当前任务图的恢复请求。',
      usage: '/task resume <taskId> [resources...]',
      arguments: [taskReference('要恢复的任务', ['running', 'queued', 'needs_action']), variadic('resources', '新增材料路径', true)],
      options: [option('--generation', '执行代际', text('generation', '执行代际')),
        option('--revision', '任务图版本', text('revision', '任务图版本'))], run: resumeTask }),
    action({ name: 'unblock', summary: '继续处理任务（兼容命令）', effect: '提交带材料的恢复请求。', usage: '/task unblock <taskId> [resources...]', category: 'advanced', arguments: [taskReference('要继续的任务', ['needs_action']), variadic('resources', '新增材料路径', true)], run: unblockTask }),
    operation('cancel', '取消任务', ['queued', 'running', 'needs_action'], cancelTask),
    action({ name: 'clear', summary: '批量取消未完成任务', effect: '经统一 Kernel 取消链取消选定范围内的未完成任务。', usage: '/task clear [all|parked|blocked]', category: 'advanced', arguments: [{ ...enumArg('scope', '任务范围', ['all', 'parked', 'blocked'], true) }], run: clearTasks }),
    action({
      name: 'subtask-cancel',
      summary: '原子取消 Subtask 及其传递下游',
      effect: '提交 Kernel durable event；独立 sibling 继续运行。',
      usage: '/task subtask-cancel <taskId> <subtaskId...>',
      category: 'advanced',
      arguments: [
        taskReference('所属任务', ['running', 'needs_action']),
        variadic('subtaskIds', '要取消的 Subtask ID'),
      ],
      run: cancelSubtasks,
    }),
    action({
      name: 'accept-partial',
      summary: '显式接受部分取消后的剩余成果',
      effect: '仅在所有节点 done/cancelled 且运行残留清零时完成 Task。',
      usage: '/task accept-partial <taskId>',
      category: 'advanced',
      arguments: [taskReference('要接受部分结果的任务', ['needs_action'])],
      run: acceptPartialResult,
    }),
    action({ name: 'retry', summary: '重试失败任务的剩余交付或服务启动',
      effect: '创建关联新任务，仅复用已核实成果补未完成工作；原任务不改。',
      usage: '/task retry <taskId>', arguments: [taskReference('失败的任务', ['failed'])],
      run: retryRemainingWork }),
    action({
      name: 'retry-result', summary: '重新执行当前待处理结果',
      effect: '提交受授权的新 Attempt，保留原结果；拒绝重复不确定的外部副作用。',
      usage: '/task retry-result <taskId>', arguments: [taskReference('要重新执行的任务', ['needs_action', 'running'])],
      run: retryResult,
    }),
    action({
      name: 'accept-result',
      summary: '接受已生成但尚未认证的结果并交付',
      effect: '重新执行确定性结果检查；通过后发布当前结果，不重跑 Executor。',
      usage: '/task accept-result <taskId>',
      arguments: [taskReference('要接受结果的任务', ['needs_action', 'queued', 'running'])],
      run: acceptResult,
    }),
    action({
      name: 'search', summary: '搜索历史任务', effect: '在任务全文索引中搜索标题、目标、交互和结果。',
      usage: '/task search <query...>', arguments: [rest('query', '检索词')],
      category: 'advanced',
      run: searchTaskIndex,
    }),
    action({ name: 'attach', summary: '为任务补充材料', effect: '将材料关联到任务，但不自动恢复任务。', usage: '/task attach <taskId> <resource...>', category: 'advanced', arguments: [taskReference('接收材料的任务'), variadic('resources', '材料路径或链接')], run: attachTaskResources }),
    action({
      name: 'recovery', summary: '查看任务恢复项', effect: '只读查看 uncertain/failed application 和外部副作用。',
      usage: '/task recovery <taskId>', arguments: [taskReference('要查看恢复项的任务')],
      category: 'advanced',
      run: async args => ({
        type: 'directive', content: '',
        directive: { kind: 'show-task-recovery', taskId: stringArg(args, 'taskId') },
      }),
    }),
    { kind: 'group', name: 'index', summary: '任务检索索引', category: 'advanced', children: [
      action({ name: 'rebuild', summary: '重建任务检索索引', effect: '从任务及相关记录重建全文检索索引。', usage: '/task index rebuild', run: rebuildTaskIndex }),
      action({ name: 'search', summary: '搜索任务检索索引（兼容命令）', effect: '在任务全文检索索引中查询并返回匹配片段。', usage: '/task index search <query...>', arguments: [rest('query', '检索词')], run: searchTaskIndex }),
    ] },
    action({
      name: 'recover', summary: '解决任务恢复项', effect: '只提交 Kernel recovery resolution event，不直接改库。',
      usage: '/task recover <taskId> <recoveryItemId> <assume-applied|retry>',
      category: 'advanced',
      arguments: [
        taskReference('要恢复的任务'),
        text('recoveryItemId', '恢复项 ID'),
        enumArg('resolution', '解决方式', ['assume-applied', 'retry']),
      ],
      run: async args => ({
        type: 'directive', content: '',
        directive: {
          kind: 'resolve-task-recovery',
          taskId: stringArg(args, 'taskId'),
          recoveryItemId: stringArg(args, 'recoveryItemId'),
          resolution: stringArg(args, 'resolution') === 'retry' ? 'retry' : 'assume_applied',
        },
      }),
    }),
    action({
      name: 'history', summary: '查看任务历史', effect: '读取指定任务最近 20 条真实交互、状态变化和执行事件。',
      usage: '/task history <taskId>', arguments: [taskReference('要查看历史的任务')],
      category: 'advanced',
      run: (args, context) => Promise.resolve({
        type: 'text',
        content: context.readServices.taskHistory(stringArg(args, 'taskId')),
      }),
    }),
  ];
}

function executorNodes(): CommandNode[] {
  const executorValues = (context: CommandCompletionContext) => {
    const names = context.executorAgentClassNames
      ?? new AgentClassRepo(context.db).findAll().map(item => item.name);
    return names.map(name => ({ id: name, label: name, description: 'executor' }));
  };
  const executorRef = (optional = false) => dynamicReference('executorName', 'Executor', executorValues, optional);
  return [
    action({ name: 'list', summary: '列出 Executor', effect: '读取 AgentClass 与 WorkUnit 注册信息。', usage: '/executor list', run: listExecutors }),
    action({
      name: 'refresh',
      summary: '重新检查 error Executor',
      effect: '只探测 error 且未禁用的 Executor，并允许 error 恢复为 healthy。',
      usage: '/executor refresh [executorName|all]',
      arguments: [executorRef(true)],
      run: refreshExecutors,
    }),
    action({
      name: 'show', summary: '查看 Executor 类型详情', effect: '展示 AgentClass 静态配置、runtime binding 和当前工作的 WorkUnit。',
      usage: '/executor show <executorName>', arguments: [executorRef()],
      run: (args, context) => Promise.resolve({
        type: 'text',
        content: context.readServices.executorDetails(stringArg(args, 'executorName')),
      }),
    }),
    action({
      name: 'feedback', summary: '查看任务的 Executor 路由反馈', effect: '按任务展示 Planner 提议、Kernel 决策、WorkUnit 过程和 Executor 结果。',
      usage: '/executor feedback <taskId>', arguments: [taskReference('要查看反馈的任务')],
      run: (args, context) => Promise.resolve({
        type: 'text',
        content: context.readServices.executorFeedback(stringArg(args, 'taskId')),
      }),
    }),
  ];
}

function profileNodes(): CommandNode[] {
  const executorValues = (context: CommandCompletionContext) => new AgentClassRepo(context.db).findAll().map(item => ({ id: item.name, label: item.name, description: item.domains.join(',') || item.kind }));
  return [
    action({ name: 'executor', summary: '查看 Executor 画像', effect: '展示 AgentClass 静态画像与 Skill 使用效果。', usage: '/profile executor <executorName>', arguments: [dynamicReference('executorName', 'Executor', executorValues)], run: showExecutorProfile }),
  ];
}

export function createDefaultCommandCatalog(): CommandCatalog {
  return new CommandCatalog([
    { kind: 'group', name: 'service', summary: '受管本地服务', category: 'advanced', children: (['start', 'status', 'logs', 'stop', 'restart'] as const).map(operation => action({
      name: operation, summary: `${operation} 本地服务`, effect: '读取服务状态或经 Kernel 授权管理进程',
      usage: `/service ${operation} <${operation === 'start' ? 'taskId' : 'serviceId'}>`,
      arguments: [{ name: 'target', kind: 'text', description: operation === 'start' ? '已发布代码的任务 ID' : '服务标识' }],
      run: (args, context) => serviceCommand(args, context, operation),
    })) },
    { kind: 'group', name: 'task', summary: '任务查看与控制', category: 'common', children: taskNodes() },
    { kind: 'group', name: 'executor', summary: 'Executor 运行诊断', category: 'advanced', children: executorNodes() },
    { kind: 'group', name: 'profile', summary: 'Executor 画像', category: 'advanced', children: profileNodes() },
    action({ name: 'config', summary: '查看当前配置', effect: '以 YAML 展示当前生效配置。', usage: '/config', category: 'advanced', run: showConfig }),
    action({ name: 'help', summary: '查看常用命令', effect: '从 CommandCatalog 静态命令树生成帮助。', usage: '/help [<commandPath...>]', arguments: [{ name: 'commandPath', kind: 'command-path', description: '命令路径', optional: true }], category: 'common', builtin: 'help' }),
    action({ name: 'exit', summary: '退出 MetaWork', effect: '持久化会话状态并请求客户端退出。', usage: '/exit', category: 'common', run: exitSession }),
  ]);
}
