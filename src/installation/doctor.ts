// Installation health checks run after staging and before activation. Executor
// commands are detected but never installed or modified.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface InstallationDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InstallationDoctorInput {
  installRoot: string;
  detectCommand(command: string): Promise<boolean>;
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

  return checks;
}
