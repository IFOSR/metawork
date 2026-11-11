#!/usr/bin/env node
// Fake Pi RPC child for manager-agent tests. Emulates the upstream record
// families we rely on: `response`, `message_end`, `turn_end`, `agent_settled`.
// Behaviour is selected with FAKE_RPC_MODE.
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_RPC_MODE ?? 'ok';
const write = record => process.stdout.write(`${JSON.stringify(record)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  const id = command.id;

  if (command.type === 'abort') {
    write({ id, type: 'response', command: 'abort', success: true });
    return;
  }
  if (command.type !== 'prompt') {
    write({ id, type: 'response', command: command.type, success: false, error: 'unsupported' });
    return;
  }
  if (mode === 'reject-prompt') {
    write({ id, type: 'response', command: 'prompt', success: false, error: 'prompt rejected' });
    return;
  }
  write({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  if (mode === 'hang') return;
  if (mode.startsWith('permission-')) {
    const verdict = mode.slice('permission-'.length);
    write({ type: 'message_end', message: { role: 'assistant', id: 'permission-call', provider: 'p', model: 'm',
      usage: { input: 17, output: 6 } } });
    write({ type: 'turn_end', toolResults: [{ toolName: 'submit_manager_proposal', isError: false,
      details: { proposal: { verdict, reason: 'the exact request matches the user goal', grantedScope: 'once' } } }] });
    write({ type: 'agent_settled', aborted: false });
    return;
  }
  if (mode === 'no-proposal') {
    write({ type: 'message_end', message: { role: 'assistant', id: 'a1', provider: 'official', model: 'm1', usage: { input: 5, output: 2 } } });
    write({ type: 'turn_end', message: {}, toolResults: [] });
    write({ type: 'agent_settled', aborted: false });
    return;
  }
  if (mode === 'provider-error') {
    // Mirrors Pi's shape when the provider rejects the call (quota, rate limit,
    // bad model): an assistant message with stopReason=error and zero usage,
    // then the turn settles without a proposal tool result.
    write({ type: 'message_end', message: { role: 'assistant', id: 'a1', provider: 'custom-model-2', model: 'glm',
      stopReason: 'error', errorMessage: '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}',
      usage: { input: 0, output: 0 } } });
    write({ type: 'turn_end', message: {}, toolResults: [] });
    write({ type: 'agent_settled', aborted: false });
    return;
  }
  if (mode === 'tool-error') {
    write({ type: 'turn_end', message: {}, toolResults: [{ toolName: 'submit_manager_proposal', isError: true, content: [{ type: 'text', text: 'schema validation failed' }] }] });
    write({ type: 'agent_settled', aborted: false });
    return;
  }
  if (mode === 'invalid-json-record') {
    process.stdout.write('not-json\n');
    return;
  }

  if (mode === 'valid-plan' || mode === 'empty-reply' || mode === 'invalid-plan' || mode === 'valid-summary' || mode === 'summary-extra-fields') {
    const plan = mode === 'summary-extra-fields'
      ? { answer: '两个标记均存在，分别用于精确验收和发布验收。', confidence: 0.88, reason: '已核验' }
      : mode === 'valid-summary' ? { answer: '两个标记均存在，分别用于精确验收和发布验收。' }
      : mode !== 'invalid-plan' ? validDirectReply() : { schemaVersion: 9, action: 'nope' };
    write({ type: 'turn_end', message: {}, toolResults: [{ toolName: 'submit_manager_proposal', isError: false, details: { proposal: plan } }] });
    write({
      type: 'message_end',
      message: { role: 'assistant', id: `call-${id}`, provider: 'p', model: 'm', usage: { input: 10, output: 4 },
        stopReason: 'stop', content: [
          { type: 'thinking', text: 'private reasoning must not be delivered' },
          ...(mode === 'empty-reply' ? [] : [{ type: 'text', text: '你好' }]),
        ] },
    });
    write({ type: 'agent_settled', aborted: false });
    return;
  }

  write({
    type: 'message_end',
    message: {
      role: 'assistant',
      id: `call-${id}`,
      provider: 'official',
      model: 'model-a',
      usage: mode === 'no-usage' ? {} : { input: 1200, output: 300,
        cacheRead: mode === 'invalid-cache' ? 'invalid' : 800 },
    },
  });
  write({
    type: 'turn_end',
    message: {},
    toolResults: [{
      toolName: 'submit_manager_proposal',
      isError: false,
      details: { proposal: { schemaVersion: 9, subtasks: [{ nodeKey: 'n1', goal: 'inspect repo' }] } },
    }],
  });
  write({ type: 'agent_settled', aborted: false });
});

function validDirectReply() {
  return {
    schemaVersion: 9,
    id: 'plan-1',
    action: 'no_action',
    confidence: 0.9,
    reason: 'simple question',
    clarificationQuestion: null,
    task: {
      binding: 'none',
      taskId: null,
      control: 'none',
      scope: null,
      title: null,
      goal: null,
      includeRecentConversationContext: false,
      priority: null,
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: null,
    workspaceIntent: null,
    source: 'anyfusion-planner',
  };
}
