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
  revisionId,
  draft,
  composerDisabled,
  running,
  blockedReason,
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
  revisionId: string | null;
  draft: string;
  composerDisabled: boolean;
  running: boolean;
  blockedReason?: string | null;
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
    <div className="workspace-shell">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
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
          revisionId={revisionId}
          onTabChange={onTabChange}
        />
        <section className="workspace-canvas">{children}</section>
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
