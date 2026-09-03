import { parseAdminArgs, type AdminCommand } from './admin-args.js';

export type ServerAction = 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'setup-feishu';

export type CliCommand =
  | { kind: 'server'; action: ServerAction }
  | { kind: 'build' }
  | { kind: 'tui'; conversationId?: string }
  | { kind: 'web'; conversationId?: string; noOpen?: boolean }
  | { kind: 'admin'; command: AdminCommand }
  | { kind: 'gateway-pairing'; command: 'list' | 'approve' | 'revoke'; userId?: string }
  | { kind: 'maintenance-reconcile' }
  | { kind: 'help' };

const SERVER_ACTIONS: readonly ServerAction[] = [
  'start',
  'stop',
  'restart',
  'status',
  'doctor',
  'setup-feishu',
];

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: 'tui' };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    return { kind: 'help' };
  }

  rejectRemovedCommand(argv);

  const [namespace, ...rest] = argv;
  if (namespace === 'server') return parseServerArgs(rest);
  if (namespace === 'build') {
    if (rest.length > 0) throw new Error(`未知 build 参数: ${rest[0]}`);
    return { kind: 'build' };
  }
  if (namespace === 'tui') return parseClientArgs('tui', rest);
  if (namespace === 'web') return parseClientArgs('web', rest);
  if (namespace === 'gateway') {
    if (rest[0] !== 'pairing') {
      throw new Error('用法: metawork gateway pairing <list|approve|revoke> [open_id]');
    }
    const command = rest[1];
    if (command !== 'list' && command !== 'approve' && command !== 'revoke') {
      throw new Error('用法: metawork gateway pairing <list|approve|revoke> [open_id]');
    }
    const userId = rest[2];
    if (command !== 'list' && !userId) {
      throw new Error(`缺少用户 ID。用法: metawork gateway pairing ${command} <open_id>`);
    }
    return { kind: 'gateway-pairing', command, userId };
  }

  if (namespace === 'doctor' || namespace === 'status') {
    throw new Error(`请使用 \`metawork server ${namespace}\``);
  }

  if (namespace === 'maintenance') {
    if (rest[0] !== 'reconcile-tasks' || rest.length > 1) {
      throw new Error('用法: metawork maintenance reconcile-tasks');
    }
    return { kind: 'maintenance-reconcile' };
  }

  const adminCommand = parseAdminArgs(argv);
  if (adminCommand) return { kind: 'admin', command: adminCommand };
  throw new Error(`未知命令: ${namespace ?? '(missing)'}`);
}

export function formatCliHelp(): string {
  return [
    'MetaWork',
    '',
    'MetaWork Server（先启动，持续运行）:',
    '  metawork server start',
    '  metawork server stop',
    '  metawork server restart',
    '  metawork server status',
    '  metawork server doctor',
    '  metawork server setup-feishu',
    '',
    '构建并激活最新版本（不启动 Server 或 Client）:',
    '  metawork build',
    '',
    'Clients（连接已有 Server）:',
    '  metawork',
    '  metawork tui [--conversation <id>]',
    '  metawork web [--conversation <id>] [--no-open]',
    '',
    'Conversation Workspace:',
    '  /workspace /absolute/path',
    '',
    '配置管理:',
    '  metawork <configure|config|provider|model|planner|executor> ...',
    '',
    '选项:',
    '  -h, --help  显示帮助',
    '',
    '兼容命令别名: anyfusion、metaclaw',
  ].join('\n');
}

function parseServerArgs(argv: readonly string[]): CliCommand {
  const [rawAction, ...rest] = argv;
  if (!rawAction) throw new Error('缺少 server 子命令');
  if (!SERVER_ACTIONS.includes(rawAction as ServerAction)) {
    throw new Error(`未知 server 子命令: ${rawAction}`);
  }
  if (rest.includes('--workspace') || rest.some(arg => arg.startsWith('--workspace='))) {
    throw new Error('server start 不接受 Workspace；请在 Client 中使用 `/workspace /absolute/path`');
  }
  if (rest.length > 0) throw new Error(`未知 server 参数: ${rest[0]}`);
  return { kind: 'server', action: rawAction as ServerAction };
}

function parseClientArgs(
  kind: 'tui' | 'web',
  argv: readonly string[],
): Extract<CliCommand, { kind: 'tui' | 'web' }> {
  let conversationId: string | undefined;
  let noOpen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--conversation') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('缺少 Conversation ID');
      if (conversationId) throw new Error('Conversation ID 只能指定一次');
      conversationId = value;
      index += 1;
      continue;
    }
    if (kind === 'web' && arg === '--no-open') {
      noOpen = true;
      continue;
    }
    if (kind === 'web' && (arg === 'start' || arg === 'restart')) {
      const replacement = arg === 'restart'
        ? 'metawork server restart'
        : 'metawork server start';
      throw new Error(`Web 不再管理 Server；请使用 \`${replacement}\``);
    }
    throw new Error(`未知 ${kind} 参数: ${arg}`);
  }
  return {
    kind,
    ...(conversationId ? { conversationId } : {}),
    ...(kind === 'web' && noOpen ? { noOpen: true } : {}),
  };
}

function rejectRemovedCommand(argv: readonly string[]): void {
  if (argv.includes('--script')) {
    throw new Error('Script Client 已移除；请使用 `metawork tui` 或 `metawork web`');
  }
  if (argv.includes('--connect')) {
    throw new Error('`--connect` 已移除；请使用 `metawork tui`');
  }
  if (argv.includes('--gateway') || (argv[0] === 'gateway' && argv[1] !== 'pairing')) {
    throw new Error('Gateway 生命周期命令已移除；请使用 `metawork server start`；配对管理用 `metawork gateway pairing`');
  }
  if (argv[0] === 'feishu') {
    throw new Error('飞书连接由 Server 自动管理；配置用 `metawork server setup-feishu`');
  }
}
