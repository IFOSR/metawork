import type { ReactNode } from 'react';
import type { WebSessionMetadata } from '../api/session-types';
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
  onSettings,
  onTabChange,
  onDraftChange,
  onSend,
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
  onSettings: () => void;
  onTabChange: (tab: WorkspaceTab) => void;
  onDraftChange: (value: string) => void;
  onSend: (value: string) => void;
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
        />
      </main>
    </div>
  );
}
