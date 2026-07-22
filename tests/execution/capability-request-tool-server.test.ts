import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CapabilityRequestToolServer } from '../../src/execution/capability-request-tool-server.js';

describe('CapabilityRequestToolServer', () => {
  it('supports a complete authenticated MCP session and forwards the bounded request', async () => {
    const received: unknown[] = [];
    const server = new CapabilityRequestToolServer({
      async request(input) {
        received.push(input);
        return { disposition: 'deny_capability', reason: 'test policy' };
      },
    }, { advertisedHost: '127.0.0.1' });
    const binding = await server.start();
    const client = new Client({ name: 'capability-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(binding.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${binding.bearerToken}` } },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('request_capability');
      const result = await client.callTool({
        name: 'request_capability',
        arguments: {
          capability: 'additional_read_resource',
          resource: 'mount:inputs/reports',
          operation: 'read',
          reason: 'inspect the supplied report',
          suggestedScope: 'once',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(received).toEqual([{
        capability: 'additional_read_resource',
        resource: 'mount:inputs/reports',
        operation: 'read',
        reason: 'inspect the supplied report',
        suggestedScope: 'once',
      }]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });
});
