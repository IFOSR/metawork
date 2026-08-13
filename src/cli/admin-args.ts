// Parses the Admin CLI surface (`anyfusion configure|config|provider|model|planner|executor|doctor|status`).
export type AdminCommand =
  | { kind: 'configure' }
  | { kind: 'config'; subcommand: ConfigSubcommand }
  | { kind: 'provider'; subcommand: ProviderSubcommand; id?: string }
  | { kind: 'model'; subcommand: ModelSubcommand; id?: string }
  | { kind: 'planner'; subcommand: PlannerSubcommand }
  | { kind: 'executor'; subcommand: ExecutorSubcommand; id?: string }
  | { kind: 'doctor' }
  | { kind: 'status' };

export type ConfigSubcommand = 'show' | 'validate' | 'diff' | 'history' | 'rollback';
export type ProviderSubcommand = 'list' | 'add' | 'edit' | 'test' | 'remove';
export type ModelSubcommand = 'list' | 'add' | 'edit' | 'test' | 'remove';
export type PlannerSubcommand = 'show' | 'configure' | 'test';
export type ExecutorSubcommand = 'list' | 'add' | 'edit' | 'enable' | 'disable' | 'remove' | 'test';

const CONFIG_SUBCOMMANDS: readonly ConfigSubcommand[] = ['show', 'validate', 'diff', 'history', 'rollback'];
const PROVIDER_SUBCOMMANDS: readonly ProviderSubcommand[] = ['list', 'add', 'edit', 'test', 'remove'];
const MODEL_SUBCOMMANDS: readonly ModelSubcommand[] = ['list', 'add', 'edit', 'test', 'remove'];
const PLANNER_SUBCOMMANDS: readonly PlannerSubcommand[] = ['show', 'configure', 'test'];
const EXECUTOR_SUBCOMMANDS: readonly ExecutorSubcommand[] = ['list', 'add', 'edit', 'enable', 'disable', 'remove', 'test'];

export function parseAdminArgs(argv: readonly string[]): AdminCommand | null {
  const [command, subcommand, id] = argv;
  switch (command) {
    case 'configure':
      return { kind: 'configure' };
    case 'doctor':
      return { kind: 'doctor' };
    case 'status':
      return { kind: 'status' };
    case 'config':
      return { kind: 'config', subcommand: requireSubcommand(subcommand, CONFIG_SUBCOMMANDS, 'config') };
    case 'provider':
      return {
        kind: 'provider',
        subcommand: requireSubcommand(subcommand, PROVIDER_SUBCOMMANDS, 'provider'),
        ...withId(id),
      };
    case 'model':
      return {
        kind: 'model',
        subcommand: requireSubcommand(subcommand, MODEL_SUBCOMMANDS, 'model'),
        ...withId(id),
      };
    case 'planner':
      return { kind: 'planner', subcommand: requireSubcommand(subcommand, PLANNER_SUBCOMMANDS, 'planner') };
    case 'executor':
      return {
        kind: 'executor',
        subcommand: requireSubcommand(subcommand, EXECUTOR_SUBCOMMANDS, 'executor'),
        ...withId(id),
      };
    default:
      return null;
  }
}

function requireSubcommand<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  namespace: string,
): T {
  if (value && allowed.includes(value as T)) return value as T;
  throw new Error(`未知 ${namespace} 子命令: ${value ?? '(missing)'}`);
}

function withId(id: string | undefined): { id?: string } {
  return id ? { id } : {};
}
