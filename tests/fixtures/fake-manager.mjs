#!/usr/bin/env node
// Fake Manager child used by manager-host tests. Behaviour is selected with
// FAKE_MANAGER_MODE so one fixture covers success and every failure mode.
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MANAGER_MODE ?? 'ok';
const protocolVersion = Number(process.env.FAKE_MANAGER_PROTOCOL ?? '1');

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.type === 'cancel') {
    if (mode === 'cancel-echo') process.stdout.write(`${JSON.stringify({ type: 'cancelled', requestId: request.targetRequestId })}\n`);
    return;
  }
  if (mode === 'exit') process.exit(3);
  if (mode === 'crash') throw new Error('fake manager crash');
  if (mode === 'hang') return;
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n');
    return;
  }
  if (mode === 'oversized') {
    process.stdout.write(`${JSON.stringify({
      type: 'planned',
      protocolVersion,
      requestId: request.requestId,
      proposal: 'x'.repeat(Number(process.env.FAKE_MANAGER_OVERSIZE ?? '2048')),
    })}\n`);
    return;
  }
  if (mode === 'env') {
    process.stdout.write(`${JSON.stringify({
      type: 'planned',
      protocolVersion,
      requestId: request.requestId,
      proposal: {
        env: {
          HOME: process.env.HOME,
          PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
          PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
          leakedProviderKey: process.env.OPENAI_API_KEY ?? null,
          leakedPiSetting: process.env.PI_SOMETHING ?? null,
          explicitOnly: process.env.METAWORK_MANAGER_TEST_FLAG ?? null,
        },
      },
    })}\n`);
    return;
  }
  if (request.type === 'ping') {
    process.stdout.write(`${JSON.stringify({ type: 'pong', protocolVersion, requestId: request.requestId })}\n`);
    return;
  }
  const delay = Number(process.env.FAKE_MANAGER_DELAY_MS ?? '0');
  const answer = () => {
    process.stdout.write(`${JSON.stringify({
      type: 'planned',
      protocolVersion,
      requestId: request.requestId,
      proposal: {
        schemaVersion: 9,
        subtasks: [{ nodeKey: 'n1', goal: `echo:${request.input.goal}` }],
      },
      usage: [{
        callId: `call-${request.requestId}`,
        providerRef: request.input.model.providerRef,
        modelRef: request.input.model.modelRef,
        inputTokens: 12,
        outputTokens: 3,
      }],
    })}\n`);
  };
  if (delay > 0) setTimeout(answer, delay);
  else answer();
});
