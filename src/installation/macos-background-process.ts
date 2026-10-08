import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const xml = (value: string): string => value.replace(/[<>&"']/gu, character =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);

export function backgroundProcessPlist(input: {
  label: string; executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(input.label)}</string>
<key>ProgramArguments</key><array>${[input.executable, ...input.args].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(input.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>StandardOutPath</key><string>${xml(input.logPath)}</string>
<key>StandardErrorPath</key><string>${xml(input.logPath)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>`;
}

/** One-shot user-session job, not a login item or another lifecycle owner.
 * setsid/unref do not escape a Finder application's macOS process coalition.
 * launchd owns the job, but still respects the application's valid code identity
 * and the user's macOS background policy. It is not a background-policy bypass.
 */
export async function startMacOSBackgroundProcess(input: {
  root: string; role: 'update' | 'server'; executable: string; args: string[];
  cwd: string; env: NodeJS.ProcessEnv; logPath: string;
}): Promise<void> {
  const root = await realpath(input.root);
  const label = `com.metawork.${input.role}.${createHash('sha256').update(root).digest('hex').slice(0, 24)}`;
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${label}`;
  const previous = await execute('/bin/launchctl', ['print', target]).then(value => value.stdout, () => null);
  if (previous !== null) {
    if (/^\s*pid = \d+$/mu.test(previous)) {
      // Concurrent clients may attach while Server is still acquiring its lock.
      // Its ordinary readiness/identity check decides whether reuse is valid.
      if (input.role === 'server') return;
      throw new Error('Background operation is already running');
    }
    // Only retire a completed one-shot job. Never boot out a live Server/helper.
    await execute('/bin/launchctl', ['bootout', target]);
  }
  const directory = join(root, 'desktop-support');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const plist = join(directory, `${input.role}-${randomUUID()}.plist`);
  const log = await open(input.logPath, 'a', 0o600);
  await log.close();
  try {
    await writeFile(plist, backgroundProcessPlist({ ...input, label }), { mode: 0o600, flag: 'wx' });
    await execute('/bin/launchctl', ['bootstrap', domain, plist]);
  } finally {
    // launchd has copied the definition. No login registration or environment
    // snapshot is left on disk, and a finished job will never auto-restart.
    await rm(plist, { force: true });
  }
}
