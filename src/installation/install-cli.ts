// Native install CLI entry. Parses install/update/rollback and drives the
// transactional InstallerCore. Concrete filesystem/process steps are injected as
// InstallerCoreDeps so the orchestration is tested without touching the real
// install root; the native bootstrap wires the real steps.
import { InstallerCore, type InstallerCoreDeps, type InstallTransactionResult } from './installer-core.js';

export type InstallCommandName = 'install' | 'update' | 'rollback';

export interface InstallCliArgs {
  command: InstallCommandName;
  releaseId: string;
  timeoutMs: number;
}

export function parseInstallArgs(argv: string[]): InstallCliArgs | null {
  const [command, releaseId] = argv;
  if (command !== 'install' && command !== 'update' && command !== 'rollback') return null;
  if (!releaseId || !releaseId.trim()) return null;
  return { command, releaseId, timeoutMs: 120_000 };
}

export async function runInstall(
  args: InstallCliArgs,
  deps: InstallerCoreDeps,
): Promise<InstallTransactionResult> {
  const upgradeId = `${args.command}_${args.releaseId}_${Date.now()}`;
  return new InstallerCore(deps).install(args.releaseId, upgradeId, args.timeoutMs);
}
