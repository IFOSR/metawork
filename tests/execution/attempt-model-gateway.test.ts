import { createServer } from 'node:http';
import { AttemptModelGatewayServer } from '../../src/execution/attempt-model-gateway.js';

describe('AttemptModelGatewayServer', () => {
  it('keeps the provider credential in Runtime and proxies only to the configured upstream', async () => {
    const upstream = createServer((request, response) => {
      expect(request.url).toBe('/v1/responses?trace=1');
      expect(request.headers.authorization).toBe('Bearer provider-secret');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream did not bind');
    const gateway = new AttemptModelGatewayServer({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      upstreamApiKey: 'provider-secret',
      advertisedHost: '127.0.0.1',
    });
    const binding = await gateway.start();
    try {
      const denied = await fetch(`${binding.baseUrl}/responses`);
      expect(denied.status).toBe(401);
      const proxied = await fetch(`${binding.baseUrl}/responses?trace=1`, {
        method: 'POST',
        headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hello' }),
      });
      expect(await proxied.json()).toEqual({ ok: true });
    } finally {
      await gateway.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
