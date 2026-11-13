import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  isNamedPipePath,
  localEndpointKind,
  probeLocalEndpoint,
  resolveLocalEndpointPath,
} from '../../src/platform/local-endpoint.js';

describe('local endpoint platform abstraction', () => {
  it('keeps Unix endpoints filesystem sockets', () => {
    expect(localEndpointKind('darwin')).toBe('unix');
    expect(localEndpointKind('linux')).toBe('unix');
    expect(resolveLocalEndpointPath('/tmp/metawork', 'gateway.sock', 'darwin'))
      .toBe('/tmp/metawork/gateway.sock');
  });

  it('uses deterministic named pipes on Windows', () => {
    const first = resolveLocalEndpointPath('C:\\Users\\test\\.metawork\\data', 'gateway.sock', 'win32');
    const second = resolveLocalEndpointPath('C:\\Users\\test\\.metawork\\data', 'gateway.sock', 'win32');
    expect(first).toBe(second);
    expect(first).toMatch(/^\\\\\.\\pipe\\metawork-gateway\.sock-[a-f0-9]{20}$/u);
    expect(isNamedPipePath(first)).toBe(true);
  });

  it('probes endpoint readiness by connecting', async () => {
    const base = mkdtempSync(`${tmpdir().replaceAll('\\', '/')}/metawork-probe-`);
    const socketPath = resolveLocalEndpointPath(base, 'gateway.sock');
    const server = createServer();
    await new Promise<void>(resolvePromise => server.listen(socketPath, resolvePromise));
    try {
      expect(await probeLocalEndpoint(socketPath, 1_000)).toBe(true);
    } finally {
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      rmSync(base, { recursive: true, force: true });
    }
    expect(await probeLocalEndpoint(socketPath, 100)).toBe(false);
  });
});
