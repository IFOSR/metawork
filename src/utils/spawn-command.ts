/** Windows cannot spawn a `.js`/`.mjs`/`.cjs` entry directly (EFTYPE); route
 *  script entries through the running Node executable on every platform so
 *  vendored CLIs work without a native wrapper binary. */
export function withNodeScriptLauncher(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (!/\.(?:cjs|mjs|js)$/iu.test(command)) {
    return { command, args: [...args] };
  }
  return { command: process.execPath, args: [command, ...args] };
}

/** Windows cannot execute `.cmd`/`.bat` shims via execFile/spawn without a
 *  shell (Node ≥18.20 refuses with EINVAL). Route shim entries through
 *  cmd.exe on Windows; other platforms and native executables pass through. */
export function withWindowsCmdShellLauncher(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args: [...args] };
  }
  const commandLine = [command, ...args]
    .map((part) => (/\s/u.test(part) ? `"${part}"` : part))
    .join(' ');
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
}
