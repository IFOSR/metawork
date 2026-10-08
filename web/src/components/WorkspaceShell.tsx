import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { desktopBridge } from '../platform/services';
import type {
  AttachmentMetadata,
  WebSessionMetadata,
  WorkspaceSummary,
} from '../api/session-types';
import { Composer } from './Composer';
import { SessionSidebar } from './SessionSidebar';
import { WorkspaceHeader, type WorkspaceTab } from './WorkspaceHeader';
import type { ThemePreference } from '../theme';
import type { AgentReadiness } from '../api/types';
import { AgentReadinessBanner } from './AgentReadinessBanner';

export function WorkspaceShell({
  sessions,
  hasMoreConversations,
  directoryLoading,
  onLoadMoreConversations,
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  selectedSessionId,
  workspaceSwitching,
  search,
  title,
  workspace,
  tab,
  connected,
  themePreference,
  composerVisible,
  draft,
  composerDisabled,
  newWorkBlocked,
  running,
  blockedReason,
  agentReadiness,
  onRefreshAgentReadiness,
  previewOpen = false,
  previewDrawer = null,
  children,
  onSearch,
  onSelectWorkspace,
  onCreateWorkspace,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onClearSessions,
  onSettings,
  onTabChange,
  onThemeChange,
  onDraftChange,
  onSend,
  onCancelTurn,
  previewMaximized,
  attachments,
  uploadError,
  onFilesSelected,
  onRemoveAttachment,
}: {
  sessions: WebSessionMetadata[];
  hasMoreConversations?: boolean;
  directoryLoading?: boolean;
  onLoadMoreConversations?: () => void;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  selectedSessionId: string | null;
  workspaceSwitching: boolean;
  search: string;
  title: string;
  workspace: WorkspaceSummary | null;
  tab: WorkspaceTab;
  connected: boolean;
  themePreference: ThemePreference;
  composerVisible: boolean;
  draft: string;
  composerDisabled: boolean;
  newWorkBlocked: boolean;
  running: boolean;
  blockedReason?: string | null;
  agentReadiness: AgentReadiness[];
  /** 右侧文档预览抽屉是否打开；打开时主画布切换为三列桌面布局。 */
  previewOpen?: boolean;
  /** 预览铺满主体时隐藏对话列，避免两列争抢宽度。 */
  previewMaximized?: boolean;
  previewDrawer?: ReactNode;
  children: ReactNode;
  onSearch: (value: string) => void;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClearSessions: () => void;
  onSettings: () => void;
  onRefreshAgentReadiness: () => void;
  onTabChange: (tab: WorkspaceTab) => void;
  onThemeChange: (preference: ThemePreference) => void;
  onDraftChange: (value: string) => void;
  onSend: (value: string, attachments: Array<{ attachmentId: string }>) => void;
  onCancelTurn: () => void;
  attachments: Array<{ metadata: AttachmentMetadata }>;
  uploadError?: string | null;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
}) {
  const [sidebarHidden, setSidebarHidden] = useState(() => Boolean(desktopBridge() && window.matchMedia('(max-width: 1000px)').matches));
  const shellRef = useRef<HTMLDivElement>(null);
  const [focusSearch, setFocusSearch] = useState(false);
  useLayoutEffect(() => {
    if (!focusSearch || sidebarHidden) return;
    // Focus only after React commits the visible sidebar. An animation frame
    // can run before that commit and silently focus a display:none input.
    shellRef.current?.querySelector<HTMLInputElement>('.workspace-sidebar input')?.focus();
    setFocusSearch(false);
  }, [focusSearch, sidebarHidden]);
  useEffect(() => {
    if (!desktopBridge()) return;
    const media = window.matchMedia('(max-width: 1000px)');
    const update = () => setSidebarHidden(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => desktopBridge()?.onMenu(action => {
    if (action === 'new-conversation' && !newWorkBlocked && !workspaceSwitching) onNewSession();
    if (action === 'settings') onSettings();
    if (action === 'toggle-sidebar') setSidebarHidden(value => !value);
    if (action === 'search') {
      setSidebarHidden(false);
      setFocusSearch(true);
    }
  }), [onNewSession, onSettings, newWorkBlocked, workspaceSwitching]);
  return (
    <div
      ref={shellRef}
      className="workspace-shell"
      data-sidebar-hidden={sidebarHidden || undefined}
      data-preview-open={previewOpen || undefined}
      data-preview-maximized={previewMaximized || undefined}
    >
      <SessionSidebar
        sessions={sessions}
        hasMoreConversations={hasMoreConversations}
        directoryLoading={directoryLoading}
        onLoadMoreConversations={onLoadMoreConversations}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        activeSessionId={activeSessionId}
        runningSessionId={running ? activeSessionId : null}
        selectedSessionId={selectedSessionId}
        workspaceSwitching={workspaceSwitching}
        search={search}
        onSearch={onSearch}
        onSelectWorkspace={onSelectWorkspace}
        onCreateWorkspace={onCreateWorkspace}
        onNewSession={onNewSession}
        newWorkBlocked={newWorkBlocked}
        onSelect={onSelectSession}
        onDeleteSession={onDeleteSession}
        onClearSessions={onClearSessions}
        onSettings={onSettings}
      />
      <main className="workspace-main">
        <WorkspaceHeader
          onToggleSidebar={desktopBridge() ? () => setSidebarHidden(value => !value) : undefined}
          sidebarHidden={sidebarHidden}
          title={title}
          workspace={workspace}
          tab={tab}
          connected={connected}
          themePreference={themePreference}
          onTabChange={onTabChange}
          onThemeChange={onThemeChange}
        />
        <AgentReadinessBanner
          agents={agentReadiness}
          onRefresh={onRefreshAgentReadiness}
          onOpenSettings={onSettings}
        />
        <div className="workspace-body">
          <section className="workspace-canvas">{children}</section>
          {previewOpen && previewDrawer}
        </div>
        {composerVisible && (
          <Composer
            draft={draft}
            disabled={composerDisabled}
            running={running}
            blockedReason={blockedReason}
            onDraftChange={onDraftChange}
            onSend={onSend}
            onCancel={onCancelTurn}
            attachments={attachments}
            uploadError={uploadError}
            onFilesSelected={onFilesSelected}
            onRemoveAttachment={onRemoveAttachment}
          />
        )}
      </main>
    </div>
  );
}
