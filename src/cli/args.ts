export interface CliArgs {
  help?: boolean;
  scriptPath?: string;
  gateway?: boolean;
  connect?: boolean;
  web?: boolean;
  webCommand?: 'start' | 'restart';
  webPort?: number;
  webNoOpen?: boolean;
  gatewayCommand?: 'setup' | 'run' | 'install' | 'start' | 'stop' | 'restart' | 'status' | 'pairing' | 'doctor';
  gatewayPairingCommand?: 'list' | 'approve' | 'revoke';
  gatewayPairingUserId?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      gateway: false,
      connect: false,
      help: true,
    };
  }

  if (argv[0] === 'web') {
    return parseWebArgs(argv.slice(1));
  }

  const gatewaySubcommand = parseGatewaySubcommand(argv);
  const gateway = argv.includes('--gateway') || gatewaySubcommand?.command === 'run';
  const connect = argv.includes('--connect');
  const scriptFlagIndex = argv.findIndex(arg => arg === '--script');
  if (scriptFlagIndex === -1) {
    return {
      gateway,
      connect,
      ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand.command } : {}),
      ...gatewaySubcommand?.pairing,
    };
  }

  const scriptPath = argv[scriptFlagIndex + 1];
  if (!scriptPath) {
    throw new Error('缺少脚本路径。用法: metawork --script <脚本文件>');
  }

  return {
    scriptPath,
    gateway,
    connect,
    ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand.command } : {}),
    ...gatewaySubcommand?.pairing,
  };
}

export function formatCliHelp(): string {
  return [
    'MetaWork',
    '',
    '用法:',
    '  metawork',
    '  metawork web [start|restart] [--port <端口>] [--no-open]',
    '  metawork --script <脚本文件>',
    '  metawork --gateway',
    '  metawork --connect',
    '  metawork gateway <run|setup|pairing|doctor|install|start|stop|restart|status>',
    '  metawork <configure|config|provider|model|planner|executor|doctor|status> ...',
    '',
    '选项:',
    '  -h, --help  显示帮助',
    '',
    '兼容命令别名: anyfusion、metaclaw',
  ].join('\n');
}

function parseWebArgs(argv: string[]): CliArgs {
  const result: CliArgs = { web: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const raw = argv[index + 1];
      const port = Number(raw);
      if (!raw || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`无效端口: ${raw ?? '(missing)'}`);
      }
      result.webPort = port;
      index += 1;
      continue;
    }
    if (arg === '--no-open') {
      result.webNoOpen = true;
      continue;
    }
    if (arg === 'start' || arg === 'restart') {
      result.webCommand = arg;
      continue;
    }
    throw new Error(`未知 web 参数: ${arg}`);
  }
  return result;
}

function parseGatewaySubcommand(argv: string[]): {
  command: NonNullable<CliArgs['gatewayCommand']>;
  pairing?: Pick<CliArgs, 'gatewayPairingCommand' | 'gatewayPairingUserId'>;
} | undefined {
  const gatewayIndex = argv.findIndex(arg => arg === 'gateway');
  if (gatewayIndex === -1) {
    return undefined;
  }

  const command = argv[gatewayIndex + 1] ?? 'run';
  if (command === 'pairing') {
    const pairingCommand = argv[gatewayIndex + 2] ?? 'list';
    if (pairingCommand !== 'list' && pairingCommand !== 'approve' && pairingCommand !== 'revoke') {
      throw new Error(`未知 gateway pairing 子命令: ${pairingCommand}`);
    }
    return {
      command,
      pairing: {
        gatewayPairingCommand: pairingCommand,
        ...(argv[gatewayIndex + 3] ? { gatewayPairingUserId: argv[gatewayIndex + 3] } : {}),
      },
    };
  }
  if (
    command === 'setup'
    || command === 'run'
    || command === 'install'
    || command === 'doctor'
    || command === 'start'
    || command === 'stop'
    || command === 'restart'
    || command === 'status'
  ) {
    return { command };
  }
  throw new Error(`未知 gateway 子命令: ${command}`);
}
