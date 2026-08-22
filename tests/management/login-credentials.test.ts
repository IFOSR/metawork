import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLoginCredentials,
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
    expect(credentials.generated).toBe(false);
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
    expect(verifyLogin('carol', 'plain-secret', credentials)).toBe(true);
    expect(verifyLogin('carol', 'other-secret', credentials)).toBe(false);
  });

  it('generates a random password when nothing is configured', () => {
    const first = resolveLoginCredentials({});
    const second = resolveLoginCredentials({});

    expect(first.username).toBe('admin');
    expect(first.password).toMatch(/^[A-Za-z0-9]{8}$/u);
    expect(first.generated).toBe(true);
    expect(second.password).not.toBe(first.password);
  });

  it('generateLoginCredentials exposes username and password for startup presentation', () => {
    const credentials = generateLoginCredentials();

    expect(credentials.username).toBe('admin');
    expect(credentials.password).toMatch(/^[A-Za-z0-9]{8}$/u);
    expect(credentials.generated).toBe(true);
  });
});
