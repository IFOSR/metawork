import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { runSessionInputs } from '../support/scripted-session-test-helper.js';
import { GatewayEventTestClient as ScriptedGatewaySession } from '../support/gateway-event-test-client.js';

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

    const result = await runSessionInputs({
      inputs: ['create task', '/task show {{last_task_id}}'],
      session,
    });

    expect(submitted.map(envelope => envelope.command)).toEqual([
      { kind: 'user_message', text: 'create task', attachments: [] },
      { kind: 'slash_command', text: '/task show task_1' },
    ]);
    expect(submitted.every(envelope => envelope.connectionId === 'test-client')).toBe(true);
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

    await expect(runSessionInputs({ inputs: ['hello'], session }))
      .rejects.toThrow('planner unavailable');
  });

  it('reassembles a large UTF-8 result from bounded Gateway chunks', async () => {
    const subscriptions = new GatewaySubscriptions();
    const answer = `开头-${'内容'.repeat(40_000)}-结尾`;
    const first = answer.slice(0, 45_001);
    const second = answer.slice(45_001);
    const contentHash = `sha256:${createHash('sha256')
      .update(Buffer.from(answer))
      .digest('hex')}`;
    const session = new ScriptedGatewaySession({
      accountId: 'local-default',
      conversationId: 'conv_script',
      subscriptions,
      gateway: {
        handle: async envelope => {
          const common = {
            protocolVersion: 1 as const,
            accountId: 'local-default',
            conversationId: 'conv_script',
            requestId: envelope.requestId,
            turnId: `turn_${envelope.requestId}`,
            occurredAt: '2026-08-21T00:00:00.000Z',
          };
          subscriptions.publish({
            ...common,
            eventId: 'event_available',
            sequence: 1,
            kind: 'result_delivery_available',
            payload: {
              resultId: 'result_large',
              contentHash,
              byteLength: Buffer.byteLength(answer),
              completeness: 'complete',
              certification: 'certified',
            },
          });
          for (const [index, chunk] of [first, second].entries()) {
            subscriptions.publish({
              ...common,
              eventId: `event_chunk_${index}`,
              sequence: index + 2,
              kind: 'result_chunk',
              payload: {
                resultId: 'result_large',
                offset: index === 0 ? 0 : Buffer.byteLength(first),
                chunk,
                byteLength: Buffer.byteLength(chunk),
              },
            });
          }
          subscriptions.publish({
            ...common,
            eventId: 'event_completed',
            sequence: 4,
            kind: 'result_completed',
            payload: {
              resultId: 'result_large',
              contentHash,
              byteLength: Buffer.byteLength(answer),
              completeness: 'complete',
              certification: 'certified',
            },
          });
          subscriptions.publish({
            ...common,
            eventId: 'event_final',
            sequence: 5,
            kind: 'final_answer',
            payload: { resultId: 'result_large', lines: [] },
          });
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted',
            conversationId: 'conv_script',
          };
        },
      },
      createId: prefix => `${prefix}_large`,
    });

    const result = await runSessionInputs({ inputs: ['large answer'], session });

    expect(result.output).toEqual([answer]);
  });
});
