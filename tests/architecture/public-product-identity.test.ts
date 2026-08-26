import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

const publicAuthorities = [
  'AGENTS.md',
  'CONTEXT.md',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/current/technical-overview.md',
  'docs/current/technical-overview.zh-CN.md',
  'docs/current/account-runtime-and-gateway-operations.md',
  'docs/current/phase-5-runtime-security.md',
] as const;

describe('public product identity', () => {
  it('presents MetaWork as the canonical product in current authorities', async () => {
    const files = await Promise.all(publicAuthorities.map(async path => ({
      path,
      content: await readFile(new URL(path, root), 'utf8'),
    })));

    for (const { path, content } of files) {
      expect(content, path).toContain('MetaWork');
      expect(content, path).not.toMatch(/^# AnyFusion$/mu);
      expect(content, path).not.toContain('AnyFusion is the public product name');
      expect(content, path).not.toContain('Why AnyFusion');
      expect(content, path).not.toContain('为什么用 AnyFusion');
    }
  });

  it('does not present MetaWork as Apache-licensed or open source', async () => {
    const [englishReadme, chineseReadme, packageMetadata] = await Promise.all([
      readFile(new URL('README.md', root), 'utf8'),
      readFile(new URL('README.zh-CN.md', root), 'utf8'),
      readFile(new URL('package.json', root), 'utf8'),
    ]);

    expect(englishReadme).toContain('MetaWork is proprietary');
    expect(englishReadme).toContain('AnyFusion');
    expect(chineseReadme).toContain('MetaWork 是闭源商业软件');
    expect(chineseReadme).toContain('AnyFusion');
    expect(englishReadme).not.toMatch(/MetaWork[^.\n]*(?:Apache|open[- ]source)/iu);
    expect(chineseReadme).not.toMatch(/MetaWork[^。\n]*(?:Apache|开源)/u);
    expect(JSON.parse(packageMetadata)).toMatchObject({
      name: 'metawork',
      private: true,
      license: 'UNLICENSED',
    });
  });

  it('uses MetaWork in current operational presentation', async () => {
    const paths = [
      'src/index.ts',
      'src/management/lock.ts',
      'src/management/token.ts',
      'src/management/server.ts',
      'src/session/conversation-session.ts',
      'src/account/account-startup-recovery-service.ts',
      'src/storage/database.ts',
      'web/src/components/TokenGate.tsx',
    ];
    const content = (await Promise.all(paths.map(path => readFile(new URL(path, root), 'utf8'))))
      .join('\n');

    for (const staleText of [
      'AnyFusion Web',
      'AnyFusion shutdown',
      'AnyFusion 已在运行',
      'AnyFusion 运行锁',
      'validated by AnyFusion',
      'AnyFusion restarted with orphaned active work',
      'transactional AnyFusion updater',
      'anyfusion web --no-open',
    ]) {
      expect(content).not.toContain(staleText);
    }
  });
});
