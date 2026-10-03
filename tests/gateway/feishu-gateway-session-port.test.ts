import { feishuClientConnectionId } from '../../src/gateway/feishu-conversation-routing.js';
import { clientConnectionEventStreamId } from '../../src/gateway/client-connection-event-stream.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuGatewaySessionPort } from '../../src/gateway/feishu-gateway-session-port.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { ClientActionReferences } from '../../src/gateway/client-action-reference.js';
import { SqliteClientActionReferences } from '../../src/storage/client-action-reference-repo.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { NotificationJob } from '../../src/delivery/notification-routing.js';
import type { FeishuGatewayDelivery } from '../../src/integrations/feishu-app.js';
import type { FeishuConversationRouteResult } from '../../src/gateway/feishu-conversation-routing.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  const model = new SqliteConversationReadModel(db);
  const actions = new ClientActionReferences(new SqliteClientActionReferences(db));
  const subscriptions = new GatewaySubscriptions();
  const receipt = { requestId: 'request', idempotencyKey: 'feishu:request', status: 'accepted' as const,
    conversationId: 'conversation', connectionId: 'connection', routeKind: 'conversation_terminal' as const };
  const handleMessage = vi.fn(async (): Promise<FeishuConversationRouteResult> => receipt);
  const handleCardAction = vi.fn(async (): Promise<FeishuConversationRouteResult> => receipt);
  const content = vi.fn(async (account: string, conversation: string, hash: string, offset = 0, maxBytes = 8192) =>
    model.content(account, conversation, hash, offset, maxBytes));
  const artifacts = vi.fn(() => [{ displayName: 'Report', publishedPath: '/result/report.md', mediaType: 'text/markdown', previewKind: 'markdown' }]);
  const port = new FeishuGatewaySessionPort({ accountId: 'account', tenantKey: 'tenant', actions,
    observation: { content }, subscriptions, adapter: { handleMessage, handleCardAction }, listTaskArtifacts: artifacts });
  const deliver = vi.fn(async (_delivery: FeishuGatewayDelivery) => undefined);
  port.subscribeGatewayDelivery(deliver);
  const job: NotificationJob = { id: 'job', token: 'token', attempts: 0,
    route: { id: 'route', revision: 1, enabled: true, accountId: 'account', principalId: 'feishu:tenant:sender',
      conversationId: 'conversation', requestId: null, taskId: null, source: 'explicit_follow',
      destination: { platform: 'feishu', tenantKey: 'tenant', senderId: 'sender', chatId: 'chat', threadId: 'thread', chatType: 'group' } },
    fact: { accountId: 'account', conversationId: 'conversation', taskId: 'task', requestId: 'request', subjectId: 'turn',
      category: 'result', version: 'v1', payload: { answer: 'answer' } } };
  const input = { senderId: 'sender', chatId: 'chat', requestId: 'request', text: 'do work', onProgress: vi.fn() };
  return { model, actions, subscriptions, receipt, handleMessage, handleCardAction, content, artifacts, port, deliver, job, input };
}
function event(kind: GatewayEventEnvelope['kind'], payload: unknown): GatewayEventEnvelope {
  return { protocolVersion: 2, accountId: 'account', conversationId: clientConnectionEventStreamId(feishuClientConnectionId('account', { chatId: 'chat' }, { tenantKey: 'tenant', userId: 'sender' })), requestId: 'request',
    turnId: null, eventId: 'event', sequence: 1, occurredAt: '', kind, payload };
}

describe('Feishu shared read model and durable delivery adapter', () => {
  it('acknowledges input without waiting for execution or subscribing to origin content', async () => {
    const { port, input, subscriptions, deliver } = fixture();
    expect(await port.submitGatewayMessage(input)).toEqual(['消息已接收，进度和结果会继续发送到这里。']);
    subscriptions.publish({ ...event('final_answer', { lines: ['late legacy result'] }), conversationId: 'conversation' });
    expect(deliver).not.toHaveBeenCalled(); expect(input.onProgress).not.toHaveBeenCalled();
  });
  it('returns an actionable Workspace prompt when selection is missing', async () => {
    const { port, input, handleMessage, receipt } = fixture();
    handleMessage.mockResolvedValue({ ...receipt, status: 'rejected', reason: 'workspace_required' });
    expect(await port.submitGatewayMessage(input)).toEqual([expect.stringContaining('/workspace /absolute/path')]);
  });
  it('renders only the captured directory reply without a journal dependency', async () => {
    const { port, input, handleMessage, receipt } = fixture();
    handleMessage.mockResolvedValue({ ...receipt, routeKind: 'workspace_directory', workspaceId: 'workspace',
      replyEvents: [event('workspace_directory_snapshot', { workspace: { displayName: 'Repository', canonicalPath: '/repo' },
        page: { items: [{ conversationId: 'external-origin', title: 'Web task', activity: { state: 'executing', taskId: 'task' } }], nextCursor: 'opaque' } })] });
    expect(await port.submitGatewayMessage({ ...input, text: '/conversations' })).toMatchObject({
      lines: expect.arrayContaining([expect.stringContaining('Web task')]), actions: [{ value: { kind: 'workspace_conversations', cursor: 'opaque' } }] });
  });
  it('renders a duplicate Workspace receipt without expecting a second query event', async () => {
    const { port, input, handleMessage, receipt } = fixture();
    handleMessage.mockResolvedValue({ ...receipt, status: 'duplicate', routeKind: 'workspace_directory',
      directory: { workspace: { id: 'workspace', displayName: 'Repository', canonicalPath: '/repo' },
        page: { items: [{ conversationId: 'external-origin', title: 'Web task', activity: { state: 'executing', taskId: 'task' } }], nextCursor: null } },
      replyEvents: [],
    } as FeishuConversationRouteResult);
    expect(await port.submitGatewayMessage({ ...input, text: '/workspace /repo' })).toMatchObject({
      lines: expect.arrayContaining([expect.stringContaining('Web task')]),
    });
  });
  it('binds history pagination to its original user and Conversation', async () => {
    const { port, input, handleMessage, receipt, actions } = fixture();
    handleMessage.mockResolvedValue({ ...receipt, routeKind: 'conversation_attached', resourcePage: {
      turns: [{ userInput: 'question', answer: 'preview', answerRef: { hash: 'a'.repeat(64), byteLength: 99999 } }], nextCursor: 'older' } });
    const result = await port.submitGatewayMessage(input);
    if (Array.isArray(result)) throw new Error('expected history card');
    expect(result.lines).toContain(`完整正文：/read conversation ${'a'.repeat(64)} 0`);
    const token = result.actions![0]!.value.cursor;
    const identity = { accountId: 'account', principalId: 'feishu:tenant:sender', chatId: 'chat', threadId: null };
    expect(actions.resolve(token, identity)).toMatchObject({ conversationId: 'conversation', command: { kind: 'get_conversation_resource', cursor: 'older' } });
    expect(() => actions.resolve(token, { ...identity, principalId: 'feishu:tenant:other' })).toThrow();
  });
  it('captures an immediate control result before command admission returns', async () => {
    const { port, input, handleMessage, receipt, subscriptions } = fixture();
    handleMessage.mockImplementation(async () => { subscriptions.publish(event('command_result', { status: 'completed' }));
      return { ...receipt, routeKind: 'conversation_control' }; });
    expect(await port.submitGatewayMessage({ ...input, text: '/stop-task task generation conversation' }))
      .toEqual([expect.stringContaining('操作已处理')]);
  });
  it('ignores another principal reply with the same request ID', async () => {
    const { port, input, handleMessage, receipt, subscriptions } = fixture();
    handleMessage.mockImplementation(async () => {
      subscriptions.publish({ ...event('command_result', { status: 'completed' }),
        conversationId: clientConnectionEventStreamId(feishuClientConnectionId('account', { chatId: 'chat' },
          { tenantKey: 'tenant', userId: 'another-sender' })) });
      subscriptions.publish(event('command_result', { status: 'failed', reason: 'target_generation_changed' }));
      return { ...receipt, routeKind: 'conversation_control' };
    });
    expect(await port.submitGatewayMessage({ ...input, text: '/stop-task task generation conversation' }))
      .toEqual(['操作未完成：target_generation_changed']);
  });
  it('forwards signed callbacks and reports the authoritative rejection', async () => {
    const { port, handleCardAction, receipt, subscriptions } = fixture();
    handleCardAction.mockImplementation(async () => { subscriptions.publish(event('command_result', { status: 'failed', reason: 'permission_request_revision_conflict' }));
      return { ...receipt, routeKind: 'conversation_control' }; });
    const reply = await port.submitGatewayAction({ senderId: 'sender', chatId: 'chat', requestId: 'request', action: { kind: 'gateway_action', cursor: 'signed-reference' } });
    expect(reply.lines).toEqual(['操作未完成：permission_request_revision_conflict']);
  });
  it('reads the full UTF-8 result from SQLite and preserves artifact and destination identity', async () => {
    const { port, model, job, content, deliver, artifacts } = fixture();
    const body = `start\n${'结果🙂\n'.repeat(30_000)}end`;
    const answerRef = model.putContent('account', 'conversation', body);
    await port.deliverNotification({ ...job, fact: { ...job.fact, payload: { answer: 'preview', answerRef } } });
    expect(content.mock.calls.length).toBeGreaterThan(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat', threadId: 'thread', senderId: 'sender',
      reply: expect.objectContaining({ lines: expect.arrayContaining([body]), artifacts: [{ name: 'Report', path: '/result/report.md', mediaType: 'text/markdown', previewKind: 'markdown' }] }) }));
    expect(artifacts).toHaveBeenCalledWith('task');
  });
  it('provides a range reader for oversized results without full allocation', async () => {
    const { port, job, content, deliver } = fixture();
    await port.deliverNotification({ ...job, fact: { ...job.fact, payload: { answer: 'preview', answerRef: { hash: 'a'.repeat(64), byteLength: 20 * 1024 * 1024 } } } });
    expect(content).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ reply: expect.objectContaining({ lines: expect.arrayContaining([expect.stringContaining('/read conversation')]) }) }));
  });
  it('reuses one progress card and finishes it from the Task projection', async () => {
    const { port, job, deliver } = fixture();
    await port.deliverNotification({ ...job, fact: { ...job.fact, category: 'progress', subjectId: 'task', payload: {
      title: 'Research', explanation: '执行中', progressSummary: '正在查阅来源', canCancel: true, executionGeneration: 'generation' } } });
    await port.deliverNotification({ ...job, fact: { ...job.fact, category: 'progress', subjectId: 'task', payload: { title: 'Research', explanation: '已完成', canCancel: false } } });
    const first = deliver.mock.calls[0]![0]; const last = deliver.mock.calls[1]![0];
    expect(first.reply.cardUpdateKey).toBe(last.reply.cardUpdateKey);
    expect(first.reply.lines).toContain('/stop-task task generation conversation'); expect(last.reply.terminal).toBe(true);
  });
  it('withholds one-click approval for truncated details while providing the full-detail command', async () => {
    const { port, job, deliver } = fixture();
    await port.deliverNotification({ ...job, fact: { ...job.fact, category: 'approval', payload: {
      requestId: 'permission', requestRevision: 'revision', generationId: 'generation', operation: 'write', resource: '/repo',
      reason: 'needs approval', scope: 'attempt', detailsRef: { hash: 'a'.repeat(64), byteLength: 99_999 } } } });
    const reply = deliver.mock.calls[0]![0].reply;
    expect(reply.actions?.map(action => action.label)).toEqual(['拒绝']);
    expect(reply.lines).toContain('/approve permission revision generation conversation');
    expect(reply.lines.some(line => line.includes('/read conversation'))).toBe(true);
  });
  it('propagates platform failure instead of acknowledging an undelivered result', async () => {
    const { port, job, deliver } = fixture(); deliver.mockRejectedValue(new Error('platform offline'));
    await expect(port.deliverNotification(job)).rejects.toThrow('platform offline');
  });
});
