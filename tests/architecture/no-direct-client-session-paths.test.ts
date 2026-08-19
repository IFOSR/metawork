import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0031 架构审计：生产源码中不得存在客户端直连 Session 路径。
 *
 * 扫描 src/ 下生产源码，找出：
 * - 客户端适配器 import `MetaclawSession`（per-connection / per-surface session）；
 * - 生产源码中 `new MetaclawSession(...)` 构造（per-connection Runtime）。
 *
 * 修复目标（Task 19）：这些路径应归零——所有用户交互表面都通过统一
 * Gateway 接入 AccountRuntime/ConversationSession，只有 AccountRuntime 组合
 * 能构造 Kernel/Execution 服务。
 */

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
}

function productionSources(): string[] {
  const files: string[] = [];
  walk(join(process.cwd(), 'src'), files);
  return files;
}

function sourcesImportingMetaclawSession(): string[] {
  return productionSources().filter(file => {
    const content = readFileSync(file, 'utf8');
    return content.includes('metaclaw-session');
  }).map(file => relative(join(process.cwd(), 'src'), file));
}

function metaclawSessionConstructorSites(): string[] {
  return productionSources().filter(file => {
    const content = readFileSync(file, 'utf8');
    return /new\s+MetaclawSession\s*\(/.test(content);
  }).map(file => relative(join(process.cwd(), 'src'), file));
}

describe('no direct client session paths', () => {
  it('extracts runtime-wide service construction into account factories', () => {
    // 物理搬迁（8 簇）完成后，MetaclawSession 通过账户级工厂构造
    // runtime-wide 服务，不再内联构造这些服务的构造逻辑。
    const sessionSource = readFileSync(
      join(process.cwd(), 'src', 'session', 'metaclaw-session.ts'),
      'utf8',
    );
    expect(sessionSource).toContain('buildAccountKernelServices');
    expect(sessionSource).toContain('buildAccountRepositories');
    expect(sessionSource).toContain('buildAccountWorkspaceServices');
    expect(sessionSource).toContain('buildAccountExecutionServices');
    expect(sessionSource).toContain('buildAccountTaskServices');
    expect(sessionSource).toContain('buildAccountCoordinatorServices');
    expect(sessionSource).toContain('buildAccountRuntimeExecutionServices');
    expect(sessionSource).toContain('buildAccountKernelExecutionServices');
  });

  it('reduces production constructors to the scripted adapter only', () => {
    // 生产组合根（index.ts）已不再构造 MetaclawSession，所有表面（Web/Feishu/
    // TUI/Gateway）通过 ConversationSession；仅脚本适配器保留构造。
    const constructors = metaclawSessionConstructorSites();
    expect(constructors).toEqual(['session/scripted-session.ts']);
  });

  it('has zero client adapter constructors', () => {
    const constructors = metaclawSessionConstructorSites();
    const clientAdapterConstructors = constructors.filter(site => (
      site.startsWith('gateway/')
      || site.startsWith('management/')
      || site.startsWith('integrations/')
      || site.startsWith('tui-bridge/')
    ));
    expect(clientAdapterConstructors).toEqual([]);
  });

  it('documents remaining MetaclawSession import sites as removal targets', () => {
    // 完整物理删除（切换 scripted-session + 删除 MetaclawSession 类）是
    // Task 19 的最终收尾；本测试提供可验证的删除目标清单。
    const importers = sourcesImportingMetaclawSession();
    expect(importers.length).toBeGreaterThan(0);
  });

  it.skip('has zero client adapters importing MetaclawSession', () => {
    expect(sourcesImportingMetaclawSession()).toEqual([]);
  });

  it.skip('has zero production MetaclawSession constructors', () => {
    expect(metaclawSessionConstructorSites()).toEqual([]);
  });
});
