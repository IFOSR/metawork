import type { TaskStatus } from '../core/types.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { LearningCandidateRepo } from '../storage/learning-candidate-repo.js';
import { ObservationRepo } from '../storage/observation-repo.js';
import { RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';
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
import { attachCommand, configCommand, dashboardCommand, exitCommand, historyCommand } from './global-commands.js';

interface ActionInput {
  name: string;
  summary: string;
  effect: string;
  usage: string;
  examples?: string[];
  arguments?: CommandArgumentSpec[];
  options?: CommandOptionSpec[];
  unavailable?: boolean;
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
    unavailable: input.unavailable,
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
    validate: (value, context) => values(context).some(item => item.id === value)
      ? null
      : `${description}不存在: ${value}`,
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
      name: 'attach', summary: '关联资源到任务', effect: '把一个或多个资源路径持久化到指定任务。',
      usage: '/task attach <taskId> <resource...>',
      arguments: [taskReference('接收资源的任务'), variadic('resources', '资源路径')],
      run: (args, context) => invokeLegacy(attachCommand, [stringArg(args, 'taskId'), ...stringListArg(args, 'resources')], context),
    }),
    action({
      name: 'history', summary: '查看最近交互历史', effect: '无 taskId 时读取全局最近交互；按任务过滤暂未实现。',
      usage: '/task history [<taskId>]', arguments: [{ ...taskReference('要过滤的任务'), optional: true }],
      run: (args, context) => {
        const taskId = optionalStringArg(args, 'taskId');
        return taskId
          ? Promise.resolve({ type: 'unavailable', commandPath: '/task history <taskId>', content: '命令已登记但尚未实现：/task history <taskId>。参见 docs/tech-debt/pending-command-implementations.md。' })
          : invokeLegacy(historyCommand, [], context);
      },
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
    option('--command', '运行命令', text('command', '运行命令')),
    option('--args', '运行参数模板', text('args', '运行参数模板')),
    option('--check', '可用性检查命令', text('check', '检查命令')),
    option('--project-url', '项目地址', text('projectUrl', '项目地址')),
    ...['domains', 'capabilities', 'inputs', 'outputs', 'strengths', 'weaknesses', 'primary-use-cases', 'avoid-use-cases']
      .map(name => option(`--${name}` as `--${string}`, `${name} 逗号分隔列表`, text(name, `${name} 列表`))),
    option('--risk', '风险等级', enumArg('risk', '风险等级', ['low', 'medium', 'high'])),
    option('--success', '历史成功率', text('success', '0 到 1 的成功率')),
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
    action({ name: 'show', summary: '查看 Executor 详情', effect: '展示单个 Executor 的画像和运行信息。', usage: '/executor show <executorName>', arguments: [executorRef()], unavailable: true }),
    {
      kind: 'group', name: 'register', summary: '注册 Executor', fallbackAction: registerAction, children: [
        action({ name: 'wizard', summary: '启动注册向导', effect: '启动交互式 Executor 注册向导。', usage: '/executor register wizard', run: (_, c) => invokeLegacy(executorCommand, ['register', 'wizard'], c) }),
      ],
    },
    action({ name: 'unregister', summary: '反注册 Executor', effect: '删除未被 WorkUnit 使用的 AgentClass。', usage: '/executor unregister <executorName>', arguments: [executorRef()], run: (a, c) => invokeLegacy(executorCommand, ['unregister', stringArg(a, 'executorName')], c) }),
    action({ name: 'route', summary: '预览 Executor 路由', effect: '预览任务描述将选择的 Executor。', usage: '/executor route <taskDescription...>', arguments: [rest('taskDescription', '任务描述')], unavailable: true }),
    action({
      name: 'feedback', summary: '查看 Executor 路由反馈', effect: '无 taskId 时读取最近规划事件；按任务过滤暂未实现。',
      usage: '/executor feedback [<taskId>]', arguments: [{ ...taskReference('要过滤的任务'), optional: true }],
      run: (args, context) => optionalStringArg(args, 'taskId')
        ? Promise.resolve({ type: 'unavailable', commandPath: '/executor feedback <taskId>', content: '命令已登记但尚未实现：/executor feedback <taskId>。参见 docs/tech-debt/pending-command-implementations.md。' })
        : invokeLegacy(executorCommand, ['feedback'], context),
    }),
  ];
}

function memoryNodes(): CommandNode[] {
  const memoryValues = (context: CommandContext) => context.memoryEngine.list().map(item => ({ id: item.id, label: `#${item.id}`, description: item.content }));
  const observationValues = (context: CommandContext) => new ObservationRepo(context.db).findAll().map(item => ({ id: item.id, label: `#${item.id}`, description: item.pattern }));
  const policyValues = (context: CommandContext) => new RecallReviewPolicyRepo(context.db).findAll().map(item => ({ id: item.id, label: `#${item.id}`, description: item.policyType }));
  const memoryRef = () => dynamicReference('memoryId', '记忆', memoryValues);
  const observationRef = () => dynamicReference('observationId', '观察候选', observationValues);
  const scopeOption = option('--scope', '记忆作用域', enumArg('scope', '作用域', ['global', 'project', 'contact', 'task-local']));
  const typeOption = option('--type', '记忆类型', text('type', '记忆类型'));
  const subjectOption = option('--subject', '记忆主题', text('subject', '主题'));
  const editOptions = [scopeOption, typeOption, subjectOption];
  const simple = (name: string, summary: string) => action({
    name, summary, effect: summary, usage: `/memory ${name}`,
    run: (_, context) => invokeLegacy(memoryCommand, [name], context),
  });

  return [
    action({ name: 'list', summary: '列出已确认记忆', effect: '读取并展示已确认偏好。', usage: '/memory list', run: (_, c) => invokeLegacy(memoryCommand, [], c) }),
    action({ name: 'search', summary: '搜索记忆', effect: '按关键词搜索偏好记忆。', usage: '/memory search <query...>', arguments: [rest('query', '搜索内容')], run: (a, c) => invokeLegacy(memoryCommand, ['search', stringArg(a, 'query')], c) }),
    action({ name: 'add', summary: '添加记忆', effect: '新增手工确认的偏好记忆。', usage: '/memory add [options] <content...>', arguments: [rest('content', '记忆内容')], options: editOptions, run: (a, c) => invokeLegacy(memoryCommand, ['add', ...optionTokens(a, ['scope', 'type', 'subject']), stringArg(a, 'content')], c) }),
    action({ name: 'edit', summary: '编辑记忆', effect: '修改记忆的内容或元数据。', usage: '/memory edit <memoryId> [options] [content...]', arguments: [memoryRef(), rest('content', '新内容', true)], options: editOptions, run: (a, c) => invokeLegacy(memoryCommand, ['edit', stringArg(a, 'memoryId'), ...optionTokens(a, ['scope', 'type', 'subject']), stringArg(a, 'content')].filter(Boolean), c) }),
    action({ name: 'delete', summary: '删除记忆', effect: '删除指定记忆。', usage: '/memory delete <memoryId>', arguments: [memoryRef()], run: (a, c) => invokeLegacy(memoryCommand, ['delete', stringArg(a, 'memoryId')], c) }),
    simple('candidates', '列出记忆候选'),
    action({ name: 'confirm', summary: '确认记忆候选', effect: '将观察候选确认为长期记忆。', usage: '/memory confirm <observationId> [options]', arguments: [observationRef()], options: [scopeOption, subjectOption], run: (a, c) => invokeLegacy(memoryCommand, ['confirm', stringArg(a, 'observationId'), ...optionTokens(a, ['scope', 'subject'])], c) }),
    action({ name: 'reject', summary: '拒绝记忆候选', effect: '拒绝指定观察候选。', usage: '/memory reject <observationId>', arguments: [observationRef()], run: (a, c) => invokeLegacy(memoryCommand, ['reject', stringArg(a, 'observationId')], c) }),
    ...['stats', 'recent', 'auto-captured', 'timeline'].map(name => simple(name, ({ stats: '查看记忆统计', recent: '查看最近记忆事件', 'auto-captured': '查看自动捕获记忆', timeline: '查看记忆时间线' } as Record<string, string>)[name]!)),
    action({ name: 'applied', summary: '查看已应用记忆', effect: '查看全局或指定任务使用过的记忆。', usage: '/memory applied [<taskId>]', arguments: [{ ...taskReference('要过滤的任务'), optional: true }], run: (a, c) => invokeLegacy(memoryCommand, ['applied', optionalStringArg(a, 'taskId') ?? ''].filter(Boolean), c) }),
    ...['undo', 'explain', 'evidence', 'relations'].map(name => action({ name, summary: `${name} 记忆`, effect: `对指定记忆执行 ${name}。`, usage: `/memory ${name} <memoryId>`, arguments: [memoryRef()], run: (a, c) => invokeLegacy(memoryCommand, [name, stringArg(a, 'memoryId')], c) })),
    {
      kind: 'group', name: 'vault', summary: '记忆 Vault', children: ['export', 'status'].map(name => action({
        name, summary: `${name === 'export' ? '导出' : '查看'} Vault`, effect: `${name === 'export' ? '导出' : '统计'}记忆 Vault 文件。`,
        usage: `/memory vault ${name} [--dir <path>]`, options: [option('--dir', 'Vault 目录', text('dir', '目录路径'))],
        run: (a, c) => invokeLegacy(memoryCommand, ['vault', name, ...optionTokens(a, ['dir'])], c),
      })),
    },
    {
      kind: 'group', name: 'review-policy', summary: '回忆审查策略', children: [
        action({ name: 'list', summary: '列出审查策略', effect: '读取全部回忆审查策略。', usage: '/memory review-policy list', run: (_, c) => invokeLegacy(memoryCommand, ['review-policy'], c) }),
        action({ name: 'revoke', summary: '撤销审查策略', effect: '删除指定回忆审查策略。', usage: '/memory review-policy revoke <policyId>', arguments: [dynamicReference('policyId', '审查策略', policyValues)], run: (a, c) => invokeLegacy(memoryCommand, ['review-policy', 'revoke', stringArg(a, 'policyId')], c) }),
      ],
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
