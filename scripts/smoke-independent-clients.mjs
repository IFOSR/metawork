import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

const args = process.argv.slice(2);
const socketPath = option(args, '--socket');
const inputFile = option(args, '--input-file');
const workspace = option(args, '--workspace');
const outputPath = option(args, '--output');
const inputs = readFileSync(resolve(inputFile), 'utf8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean);

const client = await connect(socketPath);
const output = [];
const connectionId = `smoke_conn_${Date.now()}`;
try {
  await client.next(message => message.type === 'hello');
  // The Gateway only accepts an input inside an attached Conversation, so the
  // client binds a Workspace, creates a Conversation and attaches to it before
  // sending anything, exactly like the Web and TUI clients do.
  const selected = await command({
    requestId: `smoke_select_${Date.now()}`,
    command: { kind: 'select_workspace', path: workspace },
    scope: { kind: 'workspace' },
  });
  if (selected.status !== 'accepted' || !selected.workspaceId) {
    throw new Error(`Workspace selection failed: ${selected.reason ?? selected.status}`);
  }
  const created = await command({
    requestId: `smoke_create_${Date.now()}`,
    command: { kind: 'create_conversation', workspaceId: selected.workspaceId },
    scope: { kind: 'workspace' },
  });
  if (created.status !== 'accepted' || !created.conversationId) {
    throw new Error(`Conversation creation failed: ${created.reason ?? created.status}`);
  }
  client.socket.write(`${JSON.stringify({
    type: 'attach',
    connectionId,
    conversationId: created.conversationId,
    resumeFromSequence: 0,
  })}\n`);
  await client.next(message => message.type === 'hello' && message.attached === true);
  for (const text of inputs) await submit(text);
  writeFileSync(outputPath, `${output.join('\n')}\n`, 'utf8');
} finally {
  client.socket.end(JSON.stringify({ type: 'close' }) + '\n');
  client.socket.destroy();
}

async function command({ requestId, command: payload, scope }) {
  client.socket.write(`${JSON.stringify({
    type: 'command',
    envelope: {
      protocolVersion: 2,
      requestId,
      idempotencyKey: `${requestId}_idempotency`,
      connectionId,
      scope,
      command: payload,
      clientCapabilities: ['trace_v1'],
    },
  })}\n`);
  const terminal = await client.next(message => (
    message.type === 'receipt' && message.receipt.requestId === requestId
  ) || (message.type === 'error' && message.requestId === requestId));
  if (terminal.type === 'error') throw new Error(terminal.message);
  return terminal.receipt;
}

async function submit(text) {
  const requestId = `smoke_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  client.socket.write(`${JSON.stringify({
    type: 'input',
    requestId,
    idempotencyKey: `${requestId}_idempotency`,
    text,
  })}\n`);
  const terminal = await client.next(message => (
    (message.type === 'output' && message.event.requestId === requestId
      && (message.event.kind === 'final_answer' || message.event.kind === 'conversation_snapshot'))
    // A terminal turn error is delivered as an error carrying the event, so the
    // request id lives on the event rather than on the error envelope.
    || (message.type === 'error'
      && (message.requestId === requestId || message.event?.requestId === requestId))
  ));
  if (terminal.type === 'error') throw new Error(terminal.message);
  output.push(...terminal.lines);
}

function connect(path) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    const queued = [];
    const waiters = [];
    let buffer = '';
    socket.once('connect', () => resolvePromise({
      socket,
      next(predicate) {
        const index = queued.findIndex(predicate);
        if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
        return new Promise(resolveNext => waiters.push({ predicate, resolve: resolveNext }));
      },
    }));
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const index = waiters.findIndex(waiter => waiter.predicate(message));
        if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
        else queued.push(message);
      }
    });
  });
}
