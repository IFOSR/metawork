import { describe, expect, it } from 'vitest';
import {
  isNamedPipePath,
  localEndpointKind,
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
});
