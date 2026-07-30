#!/usr/bin/env node
import net from 'node:net';

const socketPath = process.env.ANYFUSION_BRIDGE_SOCKET;
if (!socketPath) {
  process.stderr.write('ANYFUSION_BRIDGE_SOCKET is not configured.\n');
  process.exit(1);
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  process.stderr.write(`Invalid Codex Stop hook payload: ${error.message}\n`);
  process.exit(1);
}

const event = payload?.hook_event ?? payload;
const inputMessages = Array.isArray(event?.input_messages) ? event.input_messages : [];
const userInput = [...inputMessages].reverse().find(value => typeof value === 'string' && value.trim());
const output = typeof event?.last_assistant_message === 'string'
  ? event.last_assistant_message
  : '';
let plan;
try {
  plan = JSON.parse(output);
} catch (error) {
  process.stderr.write(`Planner final output was not valid JSON: ${error.message}\n`);
  process.exit(1);
}

if (!userInput || !output) {
  process.stderr.write('Codex Stop hook did not include a user input and final assistant message.\n');
  process.exit(1);
}

try {
  const response = await request(socketPath, {
    type: 'planner_stop',
    requestId: typeof event?.turn_id === 'string' ? event.turn_id : 'planner-stop',
    userInput,
    plan,
    threadId: typeof event?.thread_id === 'string' ? event.thread_id : null,
    turnId: typeof event?.turn_id === 'string' ? event.turn_id : null,
  });
  if (response?.type !== 'response' || response?.ok !== true || response?.result?.accepted !== true) {
    throw new Error(response?.error?.message ?? 'runtime rejected the plan');
  }
  process.stdout.write(JSON.stringify({ suppress_output: true }));
} catch (error) {
  process.stderr.write(`AnyFusion runtime bridge rejected the plan: ${error.message}\n`);
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function request(path, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('runtime bridge timed out'));
    }, 15_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid runtime bridge response: ${error.message}`));
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('end', () => {
      if (!buffer.includes('\n')) {
        clearTimeout(timer);
        reject(new Error('runtime bridge closed without a response'));
      }
    });
  });
}
