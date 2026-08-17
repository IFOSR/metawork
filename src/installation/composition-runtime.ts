import type { CliArgs } from '../cli/args.js';

const NON_COMPOSITION_GATEWAY_COMMANDS = new Set<NonNullable<CliArgs['gatewayCommand']>>([
  'setup',
  'install',
  'start',
  'stop',
  'restart',
  'status',
  'pairing',
  'doctor',
]);

export function requiresCompositionLock(args: CliArgs): boolean {
  if (args.help) return false;
  if (args.connect) return false;
  if (args.gatewayCommand && NON_COMPOSITION_GATEWAY_COMMANDS.has(args.gatewayCommand)) {
    return false;
  }
  return true;
}
