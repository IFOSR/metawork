import { createConnection } from 'node:net';
import { createJsonLineParser, encodeJsonLine } from '../gateway/jsonl.js';
import type { GatewayServerMessage } from '../gateway/protocol.js';
import type {
  IssuedWebLaunchContext,
  WebLaunchContextInput,
} from '../management/web-launch-context.js';

const REGISTRATION_TIMEOUT_MS = 2_000;

export function registerWebLaunchContext(
  socketPath: string,
  input: WebLaunchContextInput,
): Promise<IssuedWebLaunchContext> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (
      outcome: { result: IssuedWebLaunchContext } | { error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };
    const timer = setTimeout(() => {
      finish({ error: new Error('Web launch registration timed out') });
    }, REGISTRATION_TIMEOUT_MS);
    const parse = createJsonLineParser<GatewayServerMessage>(message => {
      if (message.type === 'web_launch_registered') {
        finish({
          result: {
            token: message.token,
            expiresAt: message.expiresAt,
          },
        });
        return;
      }
      if (message.type === 'error') {
        finish({ error: new Error(message.message) });
      }
    }, {
      onError: error => finish({ error }),
    });
    socket.once('connect', () => {
      socket.write(encodeJsonLine({
        type: 'register_web_launch',
        workspaceHint: input.workspaceHint,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      }));
    });
    socket.on('data', parse);
    socket.once('error', error => finish({ error }));
    socket.once('close', () => {
      if (!settled) finish({ error: new Error('Gateway closed before Web launch registration') });
    });
  });
}
