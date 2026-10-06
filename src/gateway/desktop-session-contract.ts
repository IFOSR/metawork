/** Transport-only contract. No runtime implementation may enter Electron. */
export const DESKTOP_SESSION_CAPABILITY = 'desktop-session-v1';
export interface DesktopSessionIdentity {
  installationId: string;
  instanceId: string;
  accountId: string;
  releaseId: string;
  pid: number;
  webOrigin: string;
  gatewayProtocolVersion: 2;
}
export interface DesktopSessionGrant extends DesktopSessionIdentity {
  nonce: string;
  ticket: string;
  proof: string;
  expiresAt: number;
}
export function isDesktopNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
