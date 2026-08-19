import { describe, expect, it } from 'vitest';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { ScriptedGatewaySession } from '../../src/gateway/scripted-gateway-session.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { runScriptedSession } from '../../src/session/scripted-session.js';

describe('ScriptedGatewaySession', () => {
  it('routes each script line through ClientGateway and preserves task placeholders', async () => {
    const subscriptions = new GatewaySubscriptions();
    const submitted: GatewayCommandEnvelope[] = [];
    let eventSequence = 0;
    const publish = (
      requestId: string | null,
      kind: GatewayEventEnvelope['kind'],
      payload: unknown,
    ) => {
      eventSequence += 1;
      subscriptions.publish({
        protocolVersion: 1,
        eventId: `event_${eventSequence}`,
        sequence: eventSequence,
        accountId: 'local-default',
        conversationId: 'conv_script',
        requestId,
        turnId: requestId ? `turn_${requestId}` : null,
        kind,
        payload,
        occurredAt: '2026-08-19T00:00:00.000Z',
      });
    };
    const session = new ScriptedGatewaySession({
      accountId: 'local-default',
      conversationId: 'conv_script',
      subscriptions,
      gateway: {
        handle: async envelope => {
          submitted.push(envelope);
          const text = envelope.command.kind === 'user_message'
            || envelope.command.kind === 'slash_command'
            ? envelope.command.text
            : envelope.command.kind;
          publish(null, 'conversation_snapshot', {
            from: submitted.length - 1,
            lines: [`answer:${text}`],
            currentTaskId: 'task_1',
          });
          publish(null, 'task_projection', {
            currentTaskId: 'task_1',
            runtimeState: {
              runningTaskId: null,
              runningExecutorName: null,
              readyTaskIds: [],
              blockedTaskIds: [],
              parkedTaskIds: [],
              lastEvent: null,
            },
            plannerState: { status: 'idle' },
          });
          publish(envelope.requestId, 'final_answer', { lines: [`answer:${text}`] });
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted',
            conversationId: 'conv_script',
          };
        },
      },
      createId: prefix => `${prefix}_${submitted.length + 1}`,
    });

    const result = await runScriptedSession({
      inputs: ['create task', '/task show {{last_task_id}}'],
      session,
    });

    expect(submitted.map(envelope => envelope.command)).toEqual([
      { kind: 'user_message', text: 'create task', attachments: [] },
      { kind: 'slash_command', text: '/task show task_1' },
    ]);
    expect(submitted.every(envelope => envelope.connectionId === 'script')).toBe(true);
    expect(result.output).toEqual([
      'answer:create task',
      'answer:/task show task_1',
    ]);
  });

  it('fails the script when Gateway publishes a terminal error', async () => {
    const subscriptions = new GatewaySubscriptions();
    const session = new ScriptedGatewaySession({
      accountId: 'local-default',
      conversationId: 'conv_script',
      subscriptions,
      gateway: {
        handle: async envelope => {
          subscriptions.publish({
            protocolVersion: 1,
            eventId: 'event_error',
            sequence: 1,
            accountId: 'local-default',
            conversationId: 'conv_script',
            requestId: envelope.requestId,
            turnId: 'turn_1',
            kind: 'terminal_error',
            payload: { message: 'planner unavailable' },
            occurredAt: '2026-08-19T00:00:00.000Z',
          });
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted',
            conversationId: 'conv_script',
          };
        },
      },
    });

    await expect(runScriptedSession({ inputs: ['hello'], session }))
      .rejects.toThrow('planner unavailable');
  });
});
