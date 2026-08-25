import type { ReactNode } from 'react';
import type { AttachmentMetadata, WebSessionMetadata } from '../api/session-types';
import { Composer } from './Composer';
import { SessionSidebar } from './SessionSidebar';
import { WorkspaceHeader, type WorkspaceTab } from './WorkspaceHeader';

export function WorkspaceShell({
  sessions,
  activeSessionId,
  selectedSessionId,
  search,
  title,
  tab,
  connected,
  draft,
  composerDisabled,
  running,
  blockedReason,
  previewOpen = false,
  previewDrawer = null,
  children,
  onSearch,
  onNewSession,
  onSelectSession,
  onContinueSession,
  onDeleteSession,
  onClearSessions,
  onSettings,
  onTabChange,
  onDraftChange,
  onSend,
  attachments,
  uploadError,
  onFilesSelected,
  onRemoveAttachment,
}: {
  sessions: WebSessionMetadata[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  search: string;
  title: string;
  tab: WorkspaceTab;
  connected: boolean;
  draft: string;
  composerDisabled: boolean;
  running: boolean;
  blockedReason?: string | null;
  /** 右侧文档预览抽屉是否打开；打开时主画布切换为三列桌面布局。 */
  previewOpen?: boolean;
  previewDrawer?: ReactNode;
  children: ReactNode;
  onSearch: (value: string) => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onContinueSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClearSessions: () => void;
  onSettings: () => void;
  onTabChange: (tab: WorkspaceTab) => void;
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
        activeSessionId={activeSessionId}
        runningSessionId={running ? activeSessionId : null}
        selectedSessionId={selectedSessionId}
        search={search}
        onSearch={onSearch}
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
          tab={tab}
          connected={connected}
          onTabChange={onTabChange}
        />
        <div className="workspace-body">
          <section className="workspace-canvas">{children}</section>
          {previewOpen && previewDrawer}
        </div>
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
      </main>
    </div>
  );
}
