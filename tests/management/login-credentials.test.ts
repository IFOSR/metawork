import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  resolveLoginCredentials,
  verifyLogin,
} from '../../src/management/login-credentials.js';

function scryptHash(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

describe('login credentials', () => {
  it('uses configured username and password from environment', () => {
    const credentials = resolveLoginCredentials({
      ANYFUSION_WEB_USERNAME: 'alice',
      ANYFUSION_WEB_PASSWORD: 'secret-password',
    });

    expect(credentials.username).toBe('alice');
    expect(credentials.builtInDefault).toBe(false);
    expect(verifyLogin('alice', 'secret-password', credentials)).toBe(true);
    expect(verifyLogin('alice', 'wrong', credentials)).toBe(false);
    expect(verifyLogin('bob', 'secret-password', credentials)).toBe(false);
  });

  it('supports scrypt password hashes instead of plaintext', () => {
    const hash = scryptHash('plain-secret');
    const credentials = resolveLoginCredentials({
      ANYFUSION_WEB_USERNAME: 'carol',
      ANYFUSION_WEB_PASSWORD_HASH: hash,
    });

    expect(credentials.passwordHash).toBe(hash);
    expect(credentials.builtInDefault).toBe(false);
    expect(verifyLogin('carol', 'plain-secret', credentials)).toBe(true);
    expect(verifyLogin('carol', 'other-secret', credentials)).toBe(false);
  });

  it('keeps the built-in credentials fixed instead of generating a password', () => {
    const first = resolveLoginCredentials({});
    const second = resolveLoginCredentials({});

    expect(first.username).toBe('admin');
    expect(first.password).toBe('123456');
    expect(first.builtInDefault).toBe(true);
    // 登录信息永不随机生成：两次解析必须完全一致。
    expect(second).toEqual(first);
    expect(verifyLogin('admin', '123456', first)).toBe(true);
  });

  it('honors a configured username while reporting the built-in password default', () => {
    const credentials = resolveLoginCredentials({ ANYFUSION_WEB_USERNAME: 'admin' });

    expect(credentials.username).toBe('admin');
    expect(credentials.password).toBe('123456');
    expect(credentials.builtInDefault).toBe(true);
  });
});
