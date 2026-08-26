import type { CliCommand } from '../cli/args.js';

export function requiresCompositionLock(command: CliCommand): boolean {
  return command.kind === 'server' && command.action === 'start';
}
