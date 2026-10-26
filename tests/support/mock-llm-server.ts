/**
 * Deterministic OpenAI-compatible mock used by the memory end-to-end test.
 *
 * The real TDAI extraction model is not needed to prove the plumbing: what
 * matters is that the deposit reaches the engine, that the engine extracts a
 * memory from the deposited segment, and that the recall finds it again. The
 * mock therefore returns the extraction shape the engine expects, derived from
 * the deposited conversation.
 *
 * Test support module: never imported by production code.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockLlmOptions {
  /** Turn the raw prompt into an L1 extraction result. */
  extract(prompt: string): unknown;
}

export interface MockLlm {
  baseUrl: string;
  port: number;
  requests: Array<{ body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Turn a prompt that mentions a durable preference into one instruction atom. */
export function defaultExtraction(prompt: string): unknown {
  const preference = /以后都用([^，。；\n]{2,20})/u.exec(prompt);
  const region = /([一-龥]{2,6})区单独拆/u.exec(prompt);
  const memories: Array<Record<string, unknown>> = [];
  if (preference) {
    memories.push({
      content: `用户要求 AI 以后都用${preference[1]}输出。`,
      type: 'instruction',
      priority: 90,
      source_message_ids: [],
      metadata: {},
    });
  }
  if (region) {
    memories.push({
      content: `用户做分析时会按${region[1]}区拆分结果。`,
      type: 'persona',
      priority: 70,
      source_message_ids: [],
      metadata: {},
    });
  }
  return [{
    scene_name: '我在帮用户分析数据并沉淀偏好',
    message_ids: [],
    memories,
  }];
}

export async function startMockLlm(options: MockLlmOptions = { extract: defaultExtraction }): Promise<MockLlm> {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { body = {}; }
      requests.push({ body });
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ content?: unknown }> : [];
      const prompt = messages.map(message => String(message?.content ?? '')).join('\n');
      const content = JSON.stringify(options.extract(prompt));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: String(body.model ?? 'mock-model'),
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
