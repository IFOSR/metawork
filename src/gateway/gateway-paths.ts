import { resolveLocalEndpointPath } from '../platform/local-endpoint.js';

export function resolveGatewaySocketPath(metaclawDir: string): string {
  return resolveLocalEndpointPath(metaclawDir, 'gateway.sock');
}
