// Parses the Admin CLI surface (`anyfusion configure|config|provider|model|planner|executor|doctor|status`).
export type AdminCommand =
  | { kind: 'configure' }
  | { kind: 'config'; subcommand: 'show' | 'validate' | 'history' }
  | { kind: 'config'; subcommand: 'diff' | 'rollback'; targetRevisionId?: string }
  | { kind: 'provider'; subcommand: ProviderSubcommand; id?: string }
  | { kind: 'model'; subcommand: ModelSubcommand; id?: string }
  | { kind: 'planner'; subcommand: PlannerSubcommand }
  | { kind: 'executor'; subcommand: ExecutorSubcommand; id?: string };

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
  const [command, subcommand, id, extra] = argv;
  switch (command) {
    case 'configure':
      rejectExtra(subcommand, 'configure');
      return { kind: 'configure' };
    case 'config':
      {
        const sub = requireSubcommand(subcommand, CONFIG_SUBCOMMANDS, 'config');
        if (sub === 'diff' || sub === 'rollback') {
          rejectExtra(extra, 'config');
          return { kind: 'config', subcommand: sub, targetRevisionId: id };
        }
        rejectExtra(id, 'config');
        return { kind: 'config', subcommand: sub };
      }
    case 'provider': {
      rejectExtra(extra, 'provider');
      return {
        kind: 'provider',
        subcommand: requireSubcommand(subcommand, PROVIDER_SUBCOMMANDS, 'provider'),
        ...withId(id),
      };
    }
    case 'model': {
      rejectExtra(extra, 'model');
      return {
        kind: 'model',
        subcommand: requireSubcommand(subcommand, MODEL_SUBCOMMANDS, 'model'),
        ...withId(id),
      };
    }
    case 'planner':
      rejectExtra(id, 'planner');
      return { kind: 'planner', subcommand: requireSubcommand(subcommand, PLANNER_SUBCOMMANDS, 'planner') };
    case 'executor': {
      rejectExtra(extra, 'executor');
      return {
        kind: 'executor',
        subcommand: requireSubcommand(subcommand, EXECUTOR_SUBCOMMANDS, 'executor'),
        ...withId(id),
      };
    }
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

function rejectExtra(value: string | undefined, namespace: string): void {
  if (value) throw new Error(`未知 ${namespace} 参数: ${value}`);
}
