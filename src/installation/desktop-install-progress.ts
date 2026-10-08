/** Bounded installation progress; never carries configuration or command output. */
export const desktopInstallPhases = ['verifying', 'staging-release', 'configuring', 'activating'] as const;
export type DesktopInstallPhase = typeof desktopInstallPhases[number];
