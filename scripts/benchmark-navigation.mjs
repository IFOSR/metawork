import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    runs: { type: 'string', default: '3' },
    create: { type: 'boolean', default: false },
    'create-each-run': { type: 'boolean', default: false },
  },
});
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('runs must be 1..20');
if (values['create-each-run'] && !values.create) throw new Error('--create-each-run requires --create');
const origin = values.origin ?? JSON.parse(await readFile(
  join(homedir(), '.metawork', 'server-endpoint.json'), 'utf8',
)).webOrigin;
const parsedOrigin = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)) {
  throw new Error('Navigation benchmark only accepts a loopback Server');
}
let cookie;
const samples = [];

async function request(label, path, body) {
  const start = performance.now();
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin, 'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const nextCookie = response.headers.get('set-cookie');
  if (nextCookie) cookie = nextCookie.split(';')[0];
  const text = await response.text();
  const measurement = {
    label, status: response.status,
    milliseconds: Math.round((performance.now() - start) * 10) / 10,
    bytes: Buffer.byteLength(text),
  };
  console.log(JSON.stringify(measurement));
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  samples.push(measurement);
  return text ? JSON.parse(text) : null;
}

try {
  // These are the product's built-in local credentials, not provider secrets.
  await request('login', '/api/auth/login', {
    username: process.env.METAWORK_BENCHMARK_USERNAME ?? 'admin',
    password: process.env.METAWORK_BENCHMARK_PASSWORD ?? '123456',
  });
  const { workspaces } = await request('workspaces', '/api/workspaces');
  for (const [index, workspace] of workspaces.entries()) {
    if (workspace.availability !== 'available') continue;
    let benchmarkConversationId;
    for (let run = 0; run < runs; run += 1) {
      const prefix = `workspace-${index + 1}`;
      const selection = await request(`${prefix}:select`, '/api/workspaces/select', {
        path: workspace.canonicalPath,
      });
      if (selection.activeWorkspaceId !== workspace.id) throw new Error('Workspace selection mismatch');
      const page = await request(`${prefix}:directory`,
        `/api/workspaces/${encodeURIComponent(workspace.id)}/conversations`);
      // Creation changes directory order. Keep measuring the original selection
      // instead of silently replacing history samples with newly empty records.
      benchmarkConversationId ??= page.conversations[0]?.id;
      if (benchmarkConversationId) {
        const path = `/api/conversations/${encodeURIComponent(benchmarkConversationId)}`;
        const attached = await request(`${prefix}:attach`, `${path}/attach`, {});
        if (attached.state !== 'active') throw new Error('Conversation attachment failed');
        const record = await request(`${prefix}:history`, path);
        if (record.session.id !== benchmarkConversationId) throw new Error('Conversation identity mismatch');
      }
      if (values.create && (run === 0 || values['create-each-run'])) {
        // Explicit opt-in: creates an empty benchmark Conversation, never an AI Task.
        const created = await request(`${prefix}:create`,
          `/api/workspaces/${encodeURIComponent(workspace.id)}/conversations`, {});
        if (created.session.turns.length !== 0) throw new Error('New Conversation is not empty');
        console.log(JSON.stringify({
          label: `${prefix}:created-empty-conversation`, conversationId: created.session.session.id,
        }));
      }
    }
  }
  for (const label of new Set(samples.map(sample => sample.label))) {
    const times = samples.filter(sample => sample.label === label)
      .map(sample => sample.milliseconds).sort((a, b) => a - b);
    console.log(JSON.stringify({
      label, count: times.length,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    }));
  }
} finally {
  if (cookie) await request('logout', '/api/auth/logout', {}).catch(() => undefined);
}
