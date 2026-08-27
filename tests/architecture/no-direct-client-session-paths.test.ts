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

function clientSourcesImportingMetaclawSession(): string[] {
  return productionSources().filter(file => {
    const relativePath = relative(join(process.cwd(), 'src'), file);
    if (![
      'gateway/',
      'management/',
      'integrations/',
      'tui-bridge/',
    ].some(prefix => relativePath.startsWith(prefix))) {
      return false;
    }
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
  it('keeps Workspace Catalog persistence behind Server composition', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const clientRoots = ['gateway', 'management', 'integrations', 'tui-bridge'];
    for (const root of clientRoots) {
      const files: string[] = [];
      walk(join(sourceRoot, root), files);
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        expect(source, relative(sourceRoot, file))
          .not.toMatch(/storage\/file-workspace-catalog-store/u);
      }
    }

    const gatewayFiles: string[] = [];
    walk(join(sourceRoot, 'gateway'), gatewayFiles);
    for (const file of gatewayFiles) {
      expect(readFileSync(file, 'utf8'), relative(sourceRoot, file))
        .not.toMatch(/from ['"][^'"]*storage\/file-/u);
    }
  });

  it('keeps Workspace Directory independent from Kernel, Executor, and Gateway protocol', () => {
    const directory = readFileSync(
      join(process.cwd(), 'src', 'workspace', 'workspace-directory-service.ts'),
      'utf8',
    );
    expect(directory).not.toMatch(/from ['"][^'"]*(kernel|executor|execution)\//u);

    for (const root of ['planning', 'kernel', 'executor']) {
      const files: string[] = [];
      walk(join(process.cwd(), 'src', root), files);
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), relative(join(process.cwd(), 'src'), file))
          .not.toMatch(/from ['"][^'"]*gateway\/(client-protocol|workspace-gateway-runtime)/u);
      }
    }
  });

  it('keeps the Web session catalog as a Workspace Directory adapter, not metadata authority', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'management', 'web-session-catalog.ts'),
      'utf8',
    );
    expect(source).toContain('directory.listConversations');
    expect(source).toContain('directory.listWorkspaces');
    expect(source).not.toMatch(/FileWorkspaceCatalogStore|workspaceBinding\s*:\s*\{/u);
  });

  it('keeps Workspace paths out of endpoint manifests, launch URLs, and audit fields', () => {
    const endpointManifest = readFileSync(
      join(process.cwd(), 'src', 'server', 'server-endpoint-manifest.ts'),
      'utf8',
    );
    expect(endpointManifest).not.toMatch(/canonicalPath|workspacePath|workspaceId/u);

    const audit = readFileSync(
      join(process.cwd(), 'src', 'gateway', 'audit.ts'),
      'utf8',
    );
    expect(audit).not.toMatch(/canonicalPath|workspacePath|workspaceId/u);

    const launcher = readFileSync(
      join(process.cwd(), 'src', 'client', 'web-client-launcher.ts'),
      'utf8',
    );
    const urlLine = launcher.split('\n').find(line => line.includes('const url =')) ?? '';
    expect(urlLine).toContain('#bootstrap=');
    expect(urlLine).not.toMatch(/workspace|canonical|startupWorkspacePath/u);
  });

  it('keeps ConversationSession behind narrow account facades', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'session', 'conversation-session.ts'),
      'utf8',
    );
    for (const forbidden of [
      '.kernelServices',
      '.repositories',
      '.workspaceServices',
      '.executionServices',
      '.taskServices',
      '.coordinatorServices',
      '.runtimeExecutionServices',
      '.plannerServices',
      '.conversationExecutionBinder',
      '.permissionService',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('.runtimePort.queries');
    expect(source).toContain('.runtimePort.commands');
  });

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

  it('has zero production MetaclawSession constructors', () => {
    expect(metaclawSessionConstructorSites()).toEqual([]);
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

  it('has zero client adapters importing MetaclawSession', () => {
    expect(clientSourcesImportingMetaclawSession()).toEqual([]);
  });
});
