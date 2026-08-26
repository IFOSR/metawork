import { parseCliArgs } from './cli/args.js';
import { runClientCommand } from './client/client-command.js';
import { main as runServerCommand } from './server/server-application.js';

const command = parseCliArgs(process.argv.slice(2));
const run = command.kind === 'tui' || command.kind === 'web'
  ? runClientCommand(command)
  : runServerCommand(command);

run.catch((error: unknown) => {
  console.error('启动失败:', error);
  process.exit(1);
});
