import { describe, expect, it } from 'vitest';
import { MemorySanitizer } from '../../src/memory/memory-sanitizer.js';

describe('MemorySanitizer', () => {
  const sanitizer = new MemorySanitizer();

  it('passes ordinary content through unchanged', () => {
    const result = sanitizer.sanitize('以后都用中文表格输出。');
    expect(result.status).toBe('passed');
    expect(result.content).toBe('以后都用中文表格输出。');
    expect(result.reasons).toEqual([]);
  });

  it('redacts an OpenAI style key before it can be deposited', () => {
    const result = sanitizer.sanitize('这是我的 key sk-abcdefgh12345678 请帮我看看');
    expect(result.status).toBe('sanitized');
    expect(result.reasons).toContain('contains_secret');
    expect(result.content).not.toContain('sk-abcdefgh12345678');
    expect(result.content).toContain('[REDACTED]');
  });

  it('redacts an inline credential assignment', () => {
    const result = sanitizer.sanitize('api_key=supersecretvalue 贴在配置里');
    expect(result.status).toBe('sanitized');
    expect(result.content).not.toContain('supersecretvalue');
  });

  it('redacts a GitHub style token', () => {
    const result = sanitizer.sanitize('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('keeps a dangerous command but marks the source as sanitized', () => {
    const result = sanitizer.sanitize('请执行 rm -rf / 来清理');
    expect(result.status).toBe('sanitized');
    expect(result.reasons).toContain('contains_dangerous_command');
    expect(result.content).toContain('rm -rf /');
  });

  it('redacts a complete private key block', () => {
    const result = sanitizer.sanitize([
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'));
    expect(result.status).toBe('sanitized');
    expect(result.content).not.toContain('MIIEowIBAAKCAQEA');
    expect(result.content).toContain('[REDACTED]');
  });

  it('refuses content whose secret cannot be masked', () => {
    const result = sanitizer.sanitize([
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      // The footer is missing, so the block cannot be masked as a whole.
    ].join('\n'));
    expect(result.status).toBe('refused');
    expect(result.content).toBe('');
    expect(result.reasons).toContain('unmasked_secret');
  });

  it('drops a refused turn and keeps the rest of the batch in order', () => {
    const turns = [
      { turnId: 't1', sequence: 1, userInput: '你好', assistantAnswer: '你好，需要什么？' },
      { turnId: 't2', sequence: 2, userInput: 'key sk-abcdefgh12345678', assistantAnswer: '收到' },
      { turnId: 't3', sequence: 3, userInput: '继续', assistantAnswer: '好的' },
    ];
    const result = sanitizer.sanitizeTurns(turns);
    expect(result.turns.map(turn => turn.turnId)).toEqual(['t1', 't2', 't3']);
    expect(result.sanitized).toBe(1);
    expect(result.refused).toBe(0);
    expect(result.turns[1]!.userInput).not.toContain('sk-abcdefgh12345678');
  });

  it('drops a turn whose assistant answer cannot be sanitized', () => {
    const turns = [
      {
        turnId: 't1',
        sequence: 1,
        userInput: '问题',
        assistantAnswer: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAA',
      },
    ];
    const result = sanitizer.sanitizeTurns(turns);
    expect(result.turns).toHaveLength(0);
    expect(result.refused).toBe(1);
  });
});
