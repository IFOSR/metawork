/** Bounded installation progress; never carries configuration or command output. */
export const desktopInstallPhases = ['verifying', 'staging-release', 'configuring', 'activating'] as const;
export type DesktopInstallPhase = typeof desktopInstallPhases[number];

/** Strip messages, paths and provider values while retaining native failure codes. */
export function desktopInstallFailure(error: unknown, depth = 0): object {
  if (!(error instanceof Error) || depth > 3) return { code: 'UNKNOWN' };
  const code = (error as NodeJS.ErrnoException).code;
  const win32 = /failed, Win32=(\d{1,10})$/u.exec(error.message)?.[1];
  return {
    code: ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOSPC', 'EIO'].includes(code ?? '') ? code : 'INSTALLATION_FAILED',
    ...(win32 ? { win32: Number(win32) } : {}),
    frames: (error.stack ?? '').split('\n').slice(1, 8).flatMap(line => {
      const match = /\bat (?:async )?([A-Za-z_$][\w.$]*) \(/u.exec(line);
      return match ? [match[1]] : [];
    }),
    ...(error instanceof AggregateError ? { causes: error.errors.slice(0, 4).map(cause => desktopInstallFailure(cause, depth + 1)) } : {}),
    ...(!(error instanceof AggregateError) && error.cause instanceof Error
      ? { cause: desktopInstallFailure(error.cause, depth + 1) } : {}),
  };
}
