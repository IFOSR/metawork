import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);
const readShell = async () => (await Promise.all(['App.tsx', 'observation/use-workspace-controller.ts']
  .map(path => readFile(new URL(path, root), 'utf8')))).join('\n');

describe('Web workspace shell', () => {
  it('renders session navigation, dual views, and a conversation-only composer', async () => {
    const [app, shell, sidebar, selector, header, composer, banner, http, styles] = await Promise.all([
      readShell(),
      readFile(new URL('components/WorkspaceShell.tsx', root), 'utf8'),
      readFile(new URL('components/SessionSidebar.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceSelector.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceHeader.tsx', root), 'utf8'),
      readFile(new URL('components/Composer.tsx', root), 'utf8'),
      readFile(new URL('components/AgentReadinessBanner.tsx', root), 'utf8'),
      readFile(new URL('api/http.ts', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    expect(shell).toContain('<SessionSidebar');
    expect(sidebar).toContain('<WorkspaceSelector');
    expect(selector).toContain('canonicalPath');
    expect(selector).toContain('availability');
    expect(shell).toContain('<WorkspaceHeader');
    expect(shell).toContain('<Composer');
    expect(shell).toContain('<AgentReadinessBanner');
    expect(shell).toContain('composerVisible');
    expect(shell).toContain('{composerVisible && (');
    expect(sidebar).toContain('新建会话');
    expect(sidebar).toContain('搜索会话');
    expect(sidebar).not.toContain('继续此会话');
    expect(app).not.toContain('conversation-attach-prompt');
    expect(app).not.toContain('历史只读视图');
    expect(sidebar).toContain('runningSessionId');
    expect(sidebar).toContain('activityLabel');
    expect(sidebar).toContain('session.activity?.updatedAt');
    expect(sidebar).not.toContain("active ? ' · 运行中' : ''");
    expect(header).toContain('对话');
    expect(header).toContain('轨迹');
    expect(header).toContain('workspace');
    expect(header).toContain('workspacePath');
    expect(header).toContain('点击左侧 ＋ 添加本机目录');
    expect(composer).toContain('<textarea');
    expect(app).toContain('activeSessionId');
    expect(app).toContain('activeWorkspaceId');
    expect(app).toContain('workspaces');
    expect(app).toContain('browsedSessionId');
    expect(app).toContain('workspaceSwitching');
    expect(app).toContain('conversationRequestRef');
    expect(app).toContain('useConversationTurn');
    expect(app).toContain('observations.follow(observedId)');
    expect(app).toContain('<ObservedConversationView');
    expect(app).toContain('activeWorkspace');
    expect(app).toContain('onWorkspaceChanged');
    expect(app).toContain('getAgentReadiness');
    expect(app).toContain('onAgentReadinessState');
    expect(app).toContain('requiredAgentBlock');
    expect(app).toContain('pendingInputsRef');
    expect(app).toContain('required_agent_unavailable');
    expect(app).not.toContain('liveTurnRef');
    expect(app).toContain("composerVisible={tab === 'conversation' && Boolean(selectedId)}");
    expect(app).toContain('workspace-home');
    expect(app).toContain('<ObservedTurnDetails');
    expect(http).toContain('/api/workspaces');
    expect(http).toContain('/conversations');
    expect(http).not.toContain('/api/sessions');
    expect(styles).toContain('@media (max-width: 860px)');
    expect(styles).toContain('.workspace-sidebar');
    expect(styles).toContain('.workspace-selector');
    expect(styles).toContain('.workspace-home');
    expect(styles).toContain('.agent-readiness-banner');
    expect(banner).toContain('Codex');
    expect(banner).toContain('GPT/Codex');
    expect(banner).toContain('用于 GPT/Codex 模型的代码任务');
  });

  it('creates a Workspace by browsing local directories', async () => {
    const [app, sidebar, selector, creator, http, styles] = await Promise.all([
      readShell(),
      readFile(new URL('components/SessionSidebar.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceSelector.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceCreator.tsx', root), 'utf8'),
      readFile(new URL('api/http.ts', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    // 侧栏 Workspace 卡片提供创建入口。
    expect(selector).toContain('onCreateWorkspace');
    expect(selector).toContain('workspace-create-button');
    expect(sidebar).toContain('onCreateWorkspace');
    expect(app).toContain('workspaceCreatorOpen');
    expect(app).toContain('<WorkspaceCreator');

    // 目录浏览器只通过浏览选择，不接受手输路径。
    expect(http).toContain('/api/workspaces/browse');
    expect(creator).toContain('browseWorkspaceDirectory');
    expect(creator).toContain('选择此目录');
    expect(creator).toContain('onSelect');
    expect(creator).not.toContain('<input');
    expect(creator).toContain('crumbs');
    for (const code of [
      'browse_path_invalid',
      'browse_path_forbidden',
      'browse_path_not_found',
    ]) {
      expect(creator).toContain(code);
    }

    expect(styles).toContain('.workspace-creator');
    expect(styles).toContain('.workspace-create-button');
  });

  it('keeps Workspace switching separate from Conversation attachment', async () => {
    const app = await readShell();
    const start = app.indexOf('const handleSelectWorkspace');
    const end = app.indexOf('const handleOpenArtifact');
    const workspaceHandler = app.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(workspaceHandler).not.toContain('attachConversation');
    expect(workspaceHandler).not.toContain('selectInitialSessionId');
  });

  it('disables the Workspace selector during a switch', async () => {
    const selector = await readFile(new URL('components/WorkspaceSelector.tsx', root), 'utf8');
    const sidebar = await readFile(new URL('components/SessionSidebar.tsx', root), 'utf8');
    const shell = await readFile(new URL('components/WorkspaceShell.tsx', root), 'utf8');

    expect(selector).toContain('disabled');
    expect(sidebar).toContain('workspaceSwitching');
    expect(shell).toContain('workspaceSwitching');
  });

  it('refreshes the currently browsed Conversation after its catalog entry changes', async () => {
    const app = await readShell();
    const start = app.indexOf('onSessionCatalog:');
    const end = app.indexOf('onWorkspaceDirectory:', start);
    const catalogHandler = app.slice(start, end);
    const loadRecordStart = app.indexOf('const loadRecord');
    const loadRecordEnd = app.indexOf('const ws = new WsClient', loadRecordStart);
    const loadRecord = app.slice(loadRecordStart, loadRecordEnd);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(catalogHandler).toContain('browsedConversationRef.current');
    expect(catalogHandler).toContain('loadRecord');
    expect(loadRecord).toContain('browsedConversationRef.current !== sessionId');
  });

  it('captures navigation immediately without requiring execution attachment', async () => {
    const app = await readShell();
    const start = app.indexOf('const handleSelectSession');
    const end = app.indexOf('const handleNewSession', start);
    const handler = app.slice(start, end);

    expect(handler).toContain('browsedConversationRef.current = sessionId');
    expect(handler).not.toContain('attachConversation');
    expect(handler).not.toContain('sessionId === activeSessionId');
  });

  it('uses the shared entity projection for both historical and running Turns', async () => {
    const app = await readShell();
    expect(app).toContain('useConversationWindow');
    expect(app).toContain('latestObservedTurn');
    expect(app).not.toContain('retainTerminalLiveTurnInRecord');
  });

  it('provides a three-state persisted theme control', async () => {
    const [app, header, control, styles, html] = await Promise.all([
      readShell(),
      readFile(new URL('components/WorkspaceHeader.tsx', root), 'utf8'),
      readFile(new URL('components/ThemeControl.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
      readFile(new URL('../index.html', root), 'utf8'),
    ]);

    expect(app).toContain('useThemePreference');
    expect(header).toContain('<ThemeControl');
    expect(control).toContain('跟随系统');
    expect(control).toContain('浅色');
    expect(control).toContain('深色');
    expect(styles).toContain(":root[data-theme='light']");
    expect(styles).toContain('--surface-canvas');
    expect(html).toContain('metawork.theme');
    expect(html).toContain('anyfusion.theme');
    expect(html).toContain('localStorage.removeItem(legacyKey)');
    expect(html).toContain('data-theme-preference');
  });

  it('opens a right-side document preview drawer without global horizontal overflow', async () => {
    const [app, shell, drawer, link, styles] = await Promise.all([
      readShell(),
      readFile(new URL('components/WorkspaceShell.tsx', root), 'utf8'),
      readFile(new URL('components/ArtifactPreviewDrawer.tsx', root), 'utf8'),
      readFile(new URL('components/ArtifactLink.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    // App 维护当前预览 artifact 与 loading/error 状态。
    expect(app).toContain('previewState');
    expect(app).toContain("status: 'loading'");
    expect(app).toContain("status: 'error'");
    expect(app).toContain('getArtifactPreview');
    // Escape 关闭与切换会话清空预览。
    expect(app).toContain("event.key === 'Escape'");
    expect(app).toContain('旧会话的预览与执行详情不得残留');

    // 三列桌面布局：抽屉打开时主画布收窄。
    expect(shell).toContain('data-preview-open');
    expect(shell).toContain('previewDrawer');
    expect(styles).toContain('.workspace-body');
    expect(styles).toContain('.workspace-shell[data-preview-open] .workspace-canvas');
    // 关闭抽屉后主对话恢复原布局宽度：canvas 默认 flex: 1 1 auto。
    expect(styles).toMatch(/\.workspace-body \.workspace-canvas \{[^}]*flex: 1 1 auto;/u);

    // 四种预览状态 + 收起/下载操作。
    for (const token of ['markdown', 'code', 'text', 'unsupported']) {
      expect(drawer).toContain(`'${token}'`);
    }
    expect(drawer).toContain('onToggleCollapse');
    expect(drawer).toContain('ArtifactDownload');

    // 对话与轨迹使用结构化 ArtifactLink。
    expect(link).toContain('ArtifactProjection');
    const [conversationTurn, trajectoryView] = await Promise.all([
      readFile(new URL('components/ConversationTurn.tsx', root), 'utf8'),
      readFile(new URL('components/TrajectoryView.tsx', root), 'utf8'),
    ]);
    expect(conversationTurn).toContain('<ArtifactLink');
    expect(trajectoryView).toContain('<ArtifactLink');
    expect(trajectoryView).toContain('<LiveExecutionPanel');
  });

  it('streams executor activity inline and opens a clickable per-subtask detail drawer', async () => {
    const [panel, drawer, app, conversationView, trajectoryView, styles] = await Promise.all([
      readFile(new URL('components/LiveExecutionPanel.tsx', root), 'utf8'),
      readFile(new URL('components/ExecutionDetailDrawer.tsx', root), 'utf8'),
      readShell(),
      readFile(new URL('components/ConversationView.tsx', root), 'utf8'),
      readFile(new URL('components/TrajectoryView.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    // 子任务卡可点击，回调携带 subtaskId 与标题。
    expect(panel).toContain('onSelectSubtask');
    expect(panel).toContain('is-clickable');
    expect(panel).toContain('查看 Executor 执行详情');
    // 详情抽屉按 subtaskId 过滤 trace 事件，实时追加并自动滚底。
    expect(drawer).toContain('ExecutionDetailDrawer');
    expect(drawer).toContain('.subtaskId === subtaskId');
    expect(drawer).toContain('scrollTop = body.scrollHeight');
    expect(drawer).toContain('等待第一个执行事件…');
    // App 维护 executionDetail 状态，与文档预览抽屉互斥复用右侧槽位。
    expect(app).toContain('setExecutionDetail');
    expect(app).toContain('executionDetailOpen');
    expect(app).toContain('<ObservedExecutionDetail');
    expect(app).toContain("event.key === 'Escape'");
    expect(app).toContain('setExecutionDetail(null)');
    // 对话与轨迹都传入 onOpenSubtaskDetail。
    expect(conversationView).toContain('onOpenSubtaskDetail');
    expect(trajectoryView).toContain('onOpenSubtaskDetail');
    // 样式：可点击卡片 + 详情时间线。
    expect(styles).toContain('.execution-card.is-clickable');
    expect(styles).toContain('.execution-detail-drawer');
    expect(styles).toContain('.execution-detail-stream');
  });

  it('keeps the settings drawer above the shared composer', async () => {
    const styles = await readFile(new URL('styles.css', root), 'utf8');
    const drawerBackdrop = styles.match(/\.drawer-backdrop\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(drawerBackdrop).toContain('z-index: 20');
  });
});
