import { randomBytes, timingSafeEqual } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function formatWebAccessTokenLine(token: string): string {
  return `MetaWork Web 本机访问 token（仅用于 --no-open/SSH，非 Provider API Key）: ${token}`;
}

export function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function bearerTokenFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  return match ? match[1] : null;
}
