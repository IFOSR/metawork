// Installation health checks run after staging and before activation. Executor
// commands are detected but never installed or modified.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { FileAccountRepository } from '../account/file-account-repository.js';
import { resolveAnyFusionPaths } from './paths.js';

export interface InstallationDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InstallationDoctorInput {
  installRoot: string;
  detectCommand(command: string): Promise<boolean>;
  /** 可选：~/.anyfusion 安装根，提供时追加账户布局诊断（ADR-0031）。 */
  anyfusionRoot?: string;
}

export async function runInstallationDoctor(
  input: InstallationDoctorInput,
): Promise<InstallationDoctorCheck[]> {
  const checks: InstallationDoctorCheck[] = [];

  for (const required of ['dist', 'node_modules', 'package.json', 'planner']) {
    const present = existsSync(join(input.installRoot, required));
    checks.push({
      name: required,
      ok: present,
      detail: present ? `${required} present` : `${required} missing`,
    });
  }

  for (const command of ['codex', 'pi']) {
    const detected = await input.detectCommand(command);
    checks.push({
      name: `${command}_detected`,
      ok: detected,
      detail: detected ? `${command} detected on PATH` : `${command} not detected (creates disabled profile)`,
    });
  }

  if (input.anyfusionRoot) {
    checks.push(...await runAccountDiagnostics(input.anyfusionRoot));
  }

  return checks;
}

async function runAccountDiagnostics(anyfusionRoot: string): Promise<InstallationDoctorCheck[]> {
  const paths = resolveAnyFusionPaths(undefined, anyfusionRoot);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, anyfusionRoot);
  const repository = new FileAccountRepository(paths.accountsRoot);
  const record = await repository.load(LOCAL_DEFAULT_ACCOUNT_ID);

  const legacyDatabasePresent = existsSync(paths.database);
  const accountDatabasePresent = existsSync(accountPaths.database);

  return [
    {
      name: 'account_metadata',
      ok: record !== null && record.migratedAt !== null,
      detail: record?.migratedAt
        ? `account ${LOCAL_DEFAULT_ACCOUNT_ID} migrated at ${record.migratedAt}`
        : 'account metadata missing',
    },
    {
      name: 'account_data_root',
      ok: accountDatabasePresent,
      detail: accountDatabasePresent
        ? `account data root active at ${accountPaths.data}`
        : `account data root missing at ${accountPaths.data}`,
    },
    {
      name: 'legacy_database_residue',
      ok: !legacyDatabasePresent,
      detail: legacyDatabasePresent
        ? `legacy database path still present at ${paths.database}`
        : 'legacy database path absent',
    },
  ];
}
