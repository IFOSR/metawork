import type { ReactNode } from 'react';
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
  attachments,
  uploadError,
  onFilesSelected,
  onRemoveAttachment,
}: {
  sessions: WebSessionMetadata[];
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
  attachments: Array<{ metadata: AttachmentMetadata }>;
  uploadError?: string | null;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
}) {
  return (
    <div className="workspace-shell" data-preview-open={previewOpen || undefined}>
      <SessionSidebar
        sessions={sessions}
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
