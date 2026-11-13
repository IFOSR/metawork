import { describe, expect, it } from 'vitest';
import {
  canonicalOrigin,
  describeBindingAddress,
  isLoopbackHost,
  isOriginAllowed,
  resolveServerBinding,
  serverBindingFromEnv,
} from '../../src/server/server-binding.js';

// ADR-0055 D10/D11: loopback by default, non-loopback only with an explicit
// allow-list, and no wildcard/null origins.
describe('server binding', () => {
  it('defaults to loopback with no allow-list', () => {
    const binding = resolveServerBinding();
    expect(binding).toMatchObject({ host: '127.0.0.1', loopback: true, allowedOrigins: [], trustProxy: false });
  });

  it('refuses a non-loopback bind without allowed origins', () => {
    expect(() => resolveServerBinding({ host: '0.0.0.0' }))
      .toThrow(/without allowed origins/u);
  });

  it('accepts a non-loopback bind with explicit origins', () => {
    const binding = resolveServerBinding({
      host: '0.0.0.0',
      allowedOrigins: ['https://app.example.com', 'HTTPS://App.Example.com:443/'],
    });
    expect(binding.allowedOrigins).toEqual(['https://app.example.com']);
    expect(binding.loopback).toBe(false);
  });

  it('rejects wildcard, null, credentialed and path-bearing origins', () => {
    for (const origin of ['*', 'null', 'https://user:pw@app.example.com', 'https://app.example.com/web']) {
      expect(() => canonicalOrigin(origin), origin).toThrow();
    }
  });

  it('treats loopback aliases as loopback and 0.0.0.0 as public', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('allows same-origin loopback aliases when no allow-list is configured', () => {
    const binding = resolveServerBinding();
    expect(isOriginAllowed('http://127.0.0.1:8788', binding, '127.0.0.1:8788')).toBe(true);
    expect(isOriginAllowed('http://localhost:8788', binding, '127.0.0.1:8788')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', binding, '127.0.0.1:8788')).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:9999', binding, '127.0.0.1:8788')).toBe(false);
  });

  it('ignores origins for non-browser clients', () => {
    expect(isOriginAllowed(undefined, resolveServerBinding(), '127.0.0.1:8788')).toBe(true);
  });

  it('enforces the allow-list once it is configured', () => {
    const binding = resolveServerBinding({
      host: '0.0.0.0',
      allowedOrigins: ['https://app.example.com'],
    });
    expect(isOriginAllowed('https://app.example.com', binding, '0.0.0.0:8788')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8788', binding, '0.0.0.0:8788')).toBe(false);
    expect(isOriginAllowed('https://other.example.com', binding, '0.0.0.0:8788')).toBe(false);
  });

  it('reads binding configuration from the environment', () => {
    expect(serverBindingFromEnv({})).toMatchObject({ host: '127.0.0.1', allowedOrigins: [] });
    expect(serverBindingFromEnv({
      METAWORK_SERVER_HOST: '0.0.0.0',
      METAWORK_SERVER_ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com',
      METAWORK_SERVER_TRUST_PROXY: 'true',
    })).toMatchObject({
      host: '0.0.0.0',
      loopback: false,
      allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
      trustProxy: true,
    });
    expect(() => serverBindingFromEnv({ METAWORK_SERVER_HOST: '0.0.0.0' })).toThrow(/allowed origins/u);
  });

  it('describes the bound address with brackets for IPv6', () => {
    expect(describeBindingAddress(resolveServerBinding(), 8788)).toBe('http://127.0.0.1:8788');
    expect(describeBindingAddress(resolveServerBinding({ host: '::1' }), 8788)).toBe('http://[::1]:8788');
  });
});
