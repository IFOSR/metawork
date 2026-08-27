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

export function WorkspaceShell({
  sessions,
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  selectedSessionId,
  search,
  title,
  workspace,
  tab,
  connected,
  themePreference,
  composerVisible,
  draft,
  composerDisabled,
  running,
  blockedReason,
  previewOpen = false,
  previewDrawer = null,
  children,
  onSearch,
  onSelectWorkspace,
  onNewSession,
  onSelectSession,
  onContinueSession,
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
  search: string;
  title: string;
  workspace: WorkspaceSummary | null;
  tab: WorkspaceTab;
  connected: boolean;
  themePreference: ThemePreference;
  composerVisible: boolean;
  draft: string;
  composerDisabled: boolean;
  running: boolean;
  blockedReason?: string | null;
  /** 右侧文档预览抽屉是否打开；打开时主画布切换为三列桌面布局。 */
  previewOpen?: boolean;
  previewDrawer?: ReactNode;
  children: ReactNode;
  onSearch: (value: string) => void;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onContinueSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClearSessions: () => void;
  onSettings: () => void;
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
        search={search}
        onSearch={onSearch}
        onSelectWorkspace={onSelectWorkspace}
        onNewSession={onNewSession}
        onSelect={onSelectSession}
        onContinue={onContinueSession}
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
