import { createHash } from 'node:crypto';

export function clientConnectionEventStreamId(connectionId: string): string {
  const digest = createHash('sha256').update(connectionId).digest('hex').slice(0, 32);
  return `client_connection_${digest}`;
}
