import type { TaskStatus } from '../core/types.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { LearningCandidateRepo } from '../storage/learning-candidate-repo.js';
import type { CommandHandler, CommandResult as LegacyCommandResult } from './router.js';
import {
  CommandCatalog,
  optionalStringArg,
  optionArg,
  stringArg,
  stringListArg,
  type CommandAction,
  type CommandArgumentSpec,
  type CommandContext,
  type CommandNode,
  type CommandOptionSpec,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';
import { tasksCommand, taskCommand } from './task-commands.js';
import { memoryCommand } from './memory-commands.js';
import { executorCommand } from './executor-commands.js';
import { learningCommand } from './learning-commands.js';
import { profileCommand } from './profile-commands.js';
import { attachCommand, configCommand, dashboardCommand, exitCommand } from './global-commands.js';

interface ActionInput {
  name: string;
  summary: string;
  effect: string;
  usage: string;
  examples?: string[];
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
    arguments: input.arguments,
    options: input.options,
    builtin: input.builtin,
    execute: input.run,
  };
}

function legacyContext(context: CommandContext) {
  return {
    ...context,
    activeExecutions: context.activeExecutions,
  };
}

function convertLegacyResult(result: LegacyCommandResult): CommandResult {
  const data = result.data as {
    executorRegisterWizard?: boolean;
    schedulerAction?: 'resume';
    taskId?: string;
    mode?: 'resume-parked' | 'resume-blocked';
    newlyProvidedResources?: string[];
    blockedReason?: string;
  } | undefined;
  if (data?.executorRegisterWizard) {
    return {
      type: 'directive',
      content: result.content,
      directive: { kind: 'start-executor-register-wizard' },
    };
  }
  if (data?.schedulerAction === 'resume' && data.taskId && data.mode) {
    return {
      type: 'directive',
      content: result.content,
      directive: {
        kind: 'resume-task',
        taskId: data.taskId,
        mode: data.mode,
        newlyProvidedResources: data.newlyProvidedResources,
        blockedReason: data.blockedReason,
      },
    };
  }
  return result.type === 'exit'
    ? { type: 'exit', content: result.content }
    : { type: result.type, content: result.content, payload: result.data };
}

async function invokeLegacy(
  handler: CommandHandler,
  args: string[],
  context: CommandContext,
): Promise<CommandResult> {
  return convertLegacyResult(await handler.execute(args, legacyContext(context)));
}

function optionTokens(args: ResolvedCommandArgs, names: string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const key = name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    const value = args.options[key];
    if (value === undefined || value === false) continue;
    const flag = `--${name}`;
    if (value === true) result.push(flag);
    else if (Array.isArray(value)) value.forEach(item => result.push(flag, item));
    else result.push(flag, value);
  }
  return result;
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
        .filter(task => !allowed || allowed.includes(task.status))
        .sort((left, right) => {
          if (left.id === context.currentTaskId) return -1;
          if (right.id === context.currentTaskId) return 1;
          return right.updatedAt.localeCompare(left.updatedAt);
        });
      return tasks.map(task => ({
        value: task.id,
        label: `#${task.id} ${task.title}`,
        description: `[${task.status.toUpperCase()}] ${task.title}`,
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
  values: (context: CommandContext) => Array<{ id: string; label: string; description: string }>,
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
    legacyAction: string,
    extraArguments: CommandArgumentSpec[] = [],
  ) => action({
    name,
    summary,
    effect: summary,
    usage: `/task ${name} <taskId>${extraArguments.length ? ` ${extraArguments.map(arg => arg.optional ? `[<${arg.name}...>]` : `<${arg.name}...>`).join(' ')}` : ''}`,
    arguments: [taskReference(`要${summary}的任务`, statuses), ...extraArguments],
    run: (args, context) => invokeLegacy(taskCommand, [
      stringArg(args, 'taskId'),
      legacyAction,
      ...extraArguments.flatMap(arg => arg.kind === 'rest'
        ? [stringArg(args, arg.name)].filter(Boolean)
        : stringListArg(args, arg.name)),
    ], context),
  });

  return [
    action({
      name: 'dashboard', summary: '显示任务盘面', effect: '读取任务统计、优先任务和阻塞任务并展示盘面。',
      usage: '/task dashboard', run: (_, context) => invokeLegacy(dashboardCommand, [], context),
    }),
    action({
      name: 'list', summary: '按状态查看任务', effect: '读取任务库并按指定范围分组或过滤。',
      usage: '/task list [all|active|ready|parked|blocked|done]',
      arguments: [{ ...enumArg('scope', '任务范围', ['all', 'active', 'ready', 'parked', 'blocked', 'done'], true) }],
      run: (args, context) => {
        const scope = optionalStringArg(args, 'scope');
        return invokeLegacy(tasksCommand, scope && scope !== 'all' ? [scope] : [], context);
      },
    }),
    action({
      name: 'clear', summary: '取消指定范围内的任务', effect: '先持久化取消状态，再终止其中所有运行中的实际 Executor。',
      usage: '/task clear [all|parked|blocked]',
      arguments: [{ ...enumArg('scope', '清理范围', ['all', 'parked', 'blocked'], true) }],
      run: (args, context) => invokeLegacy(tasksCommand, ['clear', optionalStringArg(args, 'scope') ?? 'all'], context),
    }),
    action({
      name: 'show', summary: '查看任务详情', effect: '读取任务状态、快照、材料、结果和恢复建议。',
      usage: '/task show <taskId>', arguments: [taskReference('要查看的任务')],
      run: (args, context) => invokeLegacy(taskCommand, [stringArg(args, 'taskId')], context),
    }),
    operation('pause', '暂停任务', ['running'], 'pause'),
    operation('resume', '恢复任务', ['parked'], 'resume'),
    operation('block', '阻塞任务', ['running'], 'block', [rest('reason', '阻塞原因')]),
    operation('unblock', '解除阻塞任务', ['blocked'], 'unblock', [variadic('resources', '新增资源', true)]),
    operation('cancel', '取消任务', ['created', 'ready', 'running', 'parked', 'blocked'], 'cancel'),
    operation('complete', '完成任务', ['running'], 'done'),
    action({
      name: 'subtask-cancel',
      summary: '原子取消 Subtask 及其传递下游',
      effect: '提交 Kernel durable event；独立 sibling 继续运行。',
      usage: '/task <taskId> subtask cancel <subtaskId...>',
      arguments: [
        taskReference('所属任务', ['running', 'blocked']),
        variadic('subtaskIds', '要取消的 Subtask ID'),
      ],
      run: (args, context) => invokeLegacy(taskCommand, [
        stringArg(args, 'taskId'),
        'subtask',
        'cancel',
        ...stringListArg(args, 'subtaskIds'),
      ], context),
    }),
    action({
      name: 'accept-partial',
      summary: '显式接受部分取消后的剩余成果',
      effect: '仅在所有节点 done/cancelled 且运行残留清零时完成 Task。',
      usage: '/task <taskId> accept-partial',
      arguments: [taskReference('要接受部分结果的任务', ['blocked'])],
      run: (args, context) => invokeLegacy(taskCommand, [
        stringArg(args, 'taskId'),
        'accept-partial',
      ], context),
    }),
    action({
      name: 'recovery', summary: '查看任务恢复项', effect: '只读查看 uncertain/failed application 和外部副作用。',
      usage: '/task recovery <taskId>', arguments: [taskReference('要查看恢复项的任务')],
      run: async args => ({
        type: 'directive', content: '',
        directive: { kind: 'show-task-recovery', taskId: stringArg(args, 'taskId') },
      }),
    }),
    action({
      name: 'recover', summary: '解决任务恢复项', effect: '只提交 Kernel recovery resolution event，不直接改库。',
      usage: '/task recover <taskId> <recoveryItemId> <assume-applied|retry>',
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
      name: 'attach', summary: '关联资源到任务', effect: '把一个或多个资源路径持久化到指定任务。',
      usage: '/task attach <taskId> <resource...>',
      arguments: [taskReference('接收资源的任务'), variadic('resources', '资源路径')],
      run: (args, context) => invokeLegacy(attachCommand, [stringArg(args, 'taskId'), ...stringListArg(args, 'resources')], context),
    }),
    action({
      name: 'history', summary: '查看任务历史', effect: '读取指定任务最近 20 条真实交互、状态变化和执行事件。',
      usage: '/task history <taskId>', arguments: [taskReference('要查看历史的任务')],
      run: (args, context) => Promise.resolve({
        type: 'text',
        content: context.readServices.taskHistory(stringArg(args, 'taskId')),
      }),
    }),
    {
      kind: 'group', name: 'index', summary: '任务检索索引', children: [
        action({
          name: 'rebuild', summary: '重建任务检索索引', effect: '从任务及相关记录重建全文检索索引。',
          usage: '/task index rebuild', run: (_, context) => invokeLegacy(taskCommand, ['index', 'rebuild'], context),
        }),
        action({
          name: 'search', summary: '搜索任务检索索引', effect: '在任务全文检索索引中查询并返回匹配片段。',
          usage: '/task index search <query...>', arguments: [rest('query', '检索词')],
          run: (args, context) => invokeLegacy(taskCommand, ['index', 'search', stringArg(args, 'query')], context),
        }),
      ],
    },
  ];
}

function executorNodes(): CommandNode[] {
  const executorValues = (context: CommandContext) => new AgentClassRepo(context.db).findAll().map(item => ({
    id: item.name, label: item.name, description: `${item.kind} · ${item.domains.join(',') || 'no domains'}`,
  }));
  const executorRef = (optional = false) => dynamicReference('executorName', 'Executor', executorValues, optional);
  const registerOptions = [
    option('--image', 'Executor image reference', text('image', 'Docker image reference')),
    option('--image-id', 'Immutable image ID', text('imageId', 'sha256 image ID')),
    option('--permission-profile', 'Permission profile', enumArg('permissionProfile', 'Permission profile', ['workspace-engineering', 'public-web-research', 'restricted-custom'])),
    option('--command', '运行命令', text('command', '运行命令')),
    option('--args', '运行参数模板', text('args', '运行参数模板')),
    option('--check', '可用性检查命令', text('check', '检查命令')),
    option('--project-url', '项目地址', text('projectUrl', '项目地址')),
    ...['domains', 'capabilities', 'inputs', 'outputs', 'strengths', 'weaknesses', 'primary-use-cases', 'avoid-use-cases']
      .map(name => option(`--${name}` as `--${string}`, `${name} 逗号分隔列表`, text(name, `${name} 列表`))),
    option('--risk', '风险等级', enumArg('risk', '风险等级', ['low', 'medium', 'high'])),
  ];
  const registerAction = action({
    name: '<executorName>', summary: '注册或更新 Executor', effect: '持久化 AgentClass 路由画像与运行绑定。',
    usage: '/executor register <executorName> [options]',
    arguments: [text('executorName', 'Executor 名称')], options: registerOptions,
    run: (args, context) => invokeLegacy(executorCommand, [
      'register', stringArg(args, 'executorName'),
      ...optionTokens(args, registerOptions.map(item => item.name.slice(2))),
    ], context),
  });

  return [
    action({ name: 'list', summary: '列出 Executor', effect: '读取 AgentClass 与 WorkUnit 注册信息。', usage: '/executor list', run: (_, c) => invokeLegacy(executorCommand, ['list'], c) }),
    action({
      name: 'show', summary: '查看 Executor 类型详情', effect: '展示 AgentClass 静态配置、runtime binding 和当前工作的 WorkUnit。',
      usage: '/executor show <executorName>', arguments: [executorRef()],
      run: (args, context) => Promise.resolve({
        type: 'text',
        content: context.readServices.executorDetails(stringArg(args, 'executorName')),
      }),
    }),
    {
      kind: 'group', name: 'register', summary: '注册 Executor', fallbackAction: registerAction, children: [
        action({ name: 'wizard', summary: '启动注册向导', effect: '启动交互式 Executor 注册向导。', usage: '/executor register wizard', run: (_, c) => invokeLegacy(executorCommand, ['register', 'wizard'], c) }),
      ],
    },
    action({ name: 'unregister', summary: '反注册 Executor', effect: '删除未被 WorkUnit 使用的 AgentClass。', usage: '/executor unregister <executorName>', arguments: [executorRef()], run: (a, c) => invokeLegacy(executorCommand, ['unregister', stringArg(a, 'executorName')], c) }),
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

function memoryNodes(): CommandNode[] {
  const memoryValues = (context: CommandContext) => context.memoryEngine.list().map(item => ({ id: item.id, label: `#${item.id}`, description: item.content }));
  const memoryRef = () => dynamicReference('memoryId', '记忆', memoryValues);
  const scopeOption = option('--scope', '记忆作用域', enumArg('scope', '作用域', ['global', 'project', 'contact', 'task-local']));
  const typeOption = option('--type', '记忆类型', text('type', '记忆类型'));
  const subjectOption = option('--subject', '记忆主题', text('subject', '主题'));
  const editOptions = [scopeOption, typeOption, subjectOption];
  return [
    action({ name: 'list', summary: '列出已确认记忆', effect: '读取并展示已确认偏好。', usage: '/memory list', run: (_, c) => invokeLegacy(memoryCommand, [], c) }),
    action({ name: 'search', summary: '搜索记忆', effect: '按关键词搜索偏好记忆。', usage: '/memory search <query...>', arguments: [rest('query', '搜索内容')], run: (a, c) => invokeLegacy(memoryCommand, ['search', stringArg(a, 'query')], c) }),
    action({ name: 'add', summary: '添加记忆', effect: '新增手工确认的偏好记忆。', usage: '/memory add [options] <content...>', arguments: [rest('content', '记忆内容')], options: editOptions, run: (a, c) => invokeLegacy(memoryCommand, ['add', ...optionTokens(a, ['scope', 'type', 'subject']), stringArg(a, 'content')], c) }),
    action({ name: 'edit', summary: '编辑记忆', effect: '修改记忆的内容或元数据。', usage: '/memory edit <memoryId> [options] [content...]', arguments: [memoryRef(), rest('content', '新内容', true)], options: editOptions, run: (a, c) => invokeLegacy(memoryCommand, ['edit', stringArg(a, 'memoryId'), ...optionTokens(a, ['scope', 'type', 'subject']), stringArg(a, 'content')].filter(Boolean), c) }),
    action({ name: 'delete', summary: '删除记忆', effect: '删除指定记忆。', usage: '/memory delete <memoryId>', arguments: [memoryRef()], run: (a, c) => invokeLegacy(memoryCommand, ['delete', stringArg(a, 'memoryId')], c) }),
    action({ name: 'stats', summary: '查看记忆统计', effect: '统计已确认的偏好记忆。', usage: '/memory stats', run: (_, c) => invokeLegacy(memoryCommand, ['stats'], c) }),
    {
      kind: 'group', name: 'vault', summary: '记忆 Vault', children: ['export', 'status'].map(name => action({
        name, summary: `${name === 'export' ? '导出' : '查看'} Vault`, effect: `${name === 'export' ? '导出' : '统计'}记忆 Vault 文件。`,
        usage: `/memory vault ${name} [--dir <path>]`, options: [option('--dir', 'Vault 目录', text('dir', '目录路径'))],
        run: (a, c) => invokeLegacy(memoryCommand, ['vault', name, ...optionTokens(a, ['dir'])], c),
      })),
    },
  ];
}

function learningNodes(): CommandNode[] {
  const values = (context: CommandContext) => new LearningCandidateRepo(context.db).listPending().map(item => ({ id: item.id, label: `#${item.id}`, description: `${item.kind} · ${item.title}` }));
  const candidateRef = () => dynamicReference('candidateId', '学习候选', values);
  const candidateAction = (name: 'approve' | 'reject', tailName: string) => action({
    name, summary: `${name === 'approve' ? '批准' : '拒绝'}学习候选`, effect: `审查并${name === 'approve' ? '批准' : '拒绝'}候选。`,
    usage: `/learning ${name} <candidateId> [${tailName}...]`, arguments: [candidateRef(), rest(tailName, tailName, true)],
    run: (a, c) => invokeLegacy(learningCommand, [name, stringArg(a, 'candidateId'), stringArg(a, tailName)].filter(Boolean), c),
  });
  const simple = (name: string, summary: string) => action({ name, summary, effect: summary, usage: `/learning ${name}`, run: (_, c) => invokeLegacy(learningCommand, [name], c) });
  return [
    simple('candidates', '列出学习候选'),
    candidateAction('approve', 'note'),
    candidateAction('reject', 'reason'),
    action({ name: 'promote', summary: '推广学习候选', effect: '通过治理门禁后沉淀记忆卡或下发 Skill。', usage: '/learning promote <candidateId>', arguments: [candidateRef()], run: (a, c) => invokeLegacy(learningCommand, ['promote', stringArg(a, 'candidateId')], c) }),
    simple('skill-feedback', '生成 Skill 运行反馈候选'),
    {
      kind: 'group', name: 'patch', summary: 'Skill Patch 治理', children: [
        action({ name: 'candidates', summary: '列出 Patch 候选', effect: '列出待审核 Skill Patch 候选。', usage: '/learning patch candidates', run: (_, c) => invokeLegacy(learningCommand, ['patch', 'candidates'], c) }),
        action({ name: 'approve', summary: '批准 Patch 候选', effect: '批准指定 Skill Patch 候选。', usage: '/learning patch approve <candidateId> [note...]', arguments: [candidateRef(), rest('note', '备注', true)], run: (a, c) => invokeLegacy(learningCommand, ['patch', 'approve', stringArg(a, 'candidateId'), stringArg(a, 'note')].filter(Boolean), c) }),
        action({ name: 'promote', summary: '推广 Patch 候选', effect: '复用学习候选推广流程下发 Patch。', usage: '/learning patch promote <candidateId>', arguments: [candidateRef()], run: (a, c) => invokeLegacy(learningCommand, ['patch', 'promote', stringArg(a, 'candidateId')], c) }),
      ],
    },
    ...['cards', 'skills', 'weekly', 'summary'].map(name => simple(name, ({ cards: '查看任务记忆卡', skills: '查看 Skill 效果', weekly: '生成学习周报', summary: '查看学习汇总' } as Record<string, string>)[name]!)),
  ];
}

function permissionNodes(): CommandNode[] {
  const requestReference = dynamicReference(
    'requestId',
    'Pending permission request',
    context => (context.db.prepare(`
      SELECT id, capability, operation, reason FROM permission_requests
      WHERE status IN ('pending', 'escalated') ORDER BY created_at, id
    `).all() as Array<{ id: string; capability: string; operation: string; reason: string }>).map(row => ({
      id: row.id,
      label: row.id,
      description: `${row.capability}/${row.operation}: ${row.reason}`,
    })),
  );
  const resolvePermission = (resolution: 'approve' | 'deny') => action({
    name: resolution,
    summary: resolution === 'approve' ? 'Approve exact permission request' : 'Deny exact permission request',
    effect: 'Submit permission_resolution_received; this does not write a grant directly.',
    usage: `/permission ${resolution} <requestId>`,
    arguments: [requestReference],
    run: async args => ({
      type: 'directive',
      content: `Permission ${resolution} submitted for ${stringArg(args, 'requestId')}.`,
      directive: { kind: 'resolve-permission', requestId: stringArg(args, 'requestId'), resolution },
    }),
  });
  return [resolvePermission('approve'), resolvePermission('deny')];
}

function profileNodes(): CommandNode[] {
  const executorValues = (context: CommandContext) => new AgentClassRepo(context.db).findAll().map(item => ({ id: item.name, label: item.name, description: item.domains.join(',') || item.kind }));
  return [
    action({ name: 'user', summary: '查看用户画像', effect: '汇总长期记忆和自动化事件。', usage: '/profile user', run: (_, c) => invokeLegacy(profileCommand, ['user'], c) }),
    action({ name: 'project', summary: '查看项目画像', effect: '按项目主题汇总项目记忆。', usage: '/profile project <name>', arguments: [text('name', '项目名称')], run: (a, c) => invokeLegacy(profileCommand, ['project', stringArg(a, 'name')], c) }),
    action({ name: 'executor', summary: '查看 Executor 画像', effect: '汇总 Executor 的 Skill 使用效果。', usage: '/profile executor [<executorName>]', arguments: [dynamicReference('executorName', 'Executor', executorValues, true)], run: (a, c) => invokeLegacy(profileCommand, ['executor', optionalStringArg(a, 'executorName') ?? ''].filter(Boolean), c) }),
  ];
}

export function createDefaultCommandCatalog(): CommandCatalog {
  return new CommandCatalog([
    { kind: 'group', name: 'permission', summary: 'Runtime permission decisions', category: 'common', children: permissionNodes() },
    { kind: 'group', name: 'task', summary: '任务查看与控制', category: 'common', children: taskNodes() },
    { kind: 'group', name: 'executor', summary: 'Executor 注册、查看与反馈', category: 'common', children: executorNodes() },
    { kind: 'group', name: 'memory', summary: '记忆与审查策略', category: 'common', children: memoryNodes() },
    { kind: 'group', name: 'profile', summary: '用户、项目和 Executor 画像', category: 'advanced', children: profileNodes() },
    { kind: 'group', name: 'learning', summary: '学习候选与 Skill 治理', category: 'advanced', children: learningNodes() },
    action({ name: 'config', summary: '查看当前配置', effect: '以 YAML 展示当前生效配置。', usage: '/config', run: (_, c) => invokeLegacy(configCommand, [], c) }),
    action({ name: 'help', summary: '查看命令树帮助', effect: '从 CommandCatalog 静态命令树生成帮助。', usage: '/help [<commandPath...>]', arguments: [{ name: 'commandPath', kind: 'command-path', description: '命令路径', optional: true }], builtin: 'help' }),
    action({ name: 'exit', summary: '退出 MetaClaw', effect: '持久化会话状态并请求客户端退出。', usage: '/exit', run: (_, c) => invokeLegacy(exitCommand, [], c) }),
  ]);
}
