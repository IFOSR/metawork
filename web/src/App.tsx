import { ObservedConversationView } from './observation/ObservedConversationView';
import { ObservedExecutionDetail, ObservedTurnDetails } from './observation/ObservedTurnDetails';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenGate } from './components/TokenGate';
import { WorkspaceCreator } from './components/WorkspaceCreator';
import { WorkspaceShell } from './components/WorkspaceShell';
import { ArtifactPreviewDrawer } from './components/ArtifactPreviewDrawer';
import { useWorkspaceController } from './observation/use-workspace-controller';

export function App() {
  const {
    themePreference, setThemePreference, authenticated, authError, connected,
    workspaces, activeWorkspaceId, sessions, directoryCursor, directoryLoading,
    activeSessionId, workspaceSwitching, tab, setTab, setSelectedTrajectoryTurnId,
    draft, route, search, setSearch, settingsOpen,
    setSettingsOpen, workspaceCreatorOpen, setWorkspaceCreatorOpen, configurationRuntime, agentReadiness,
    pendingAttachments, handleRemoveAttachment, uploadError, previewState, setPreviewState,
    previewCollapsed, setPreviewCollapsed, previewMaximized, setPreviewMaximized, previewWidth,
    setPreviewWidth, executionDetail, setExecutionDetail, httpRef, observationClient,
    viewportMemory, openTrajectory, openBilling, handleSelectWorkspace, handleCreateWorkspace,
    handleOpenArtifact, handleLoadMoreConversations, handleSelectSession, handleNewSession, handleRefreshAgentReadiness,
    handleOpenAgentSettings, handleDeleteSession, handleFilesSelected, handleClearSessions, handleAuth,
    handleLogin, activeWorkspace, selectedId, selectedMetadata, selectedTrajectoryTurn,
    selectedBillingTurn, running, requiredBlock, composerDisabled, composerBlockedReason,
    handleDraftChange, handleSend, handleCancelTurn, executionDetailTurn, executionDetailOpen,
    failedInput, handleRestoreFailedInput,
  } = useWorkspaceController();
  useEffect(() => { document.title = activeWorkspace ? `MetaWork · ${activeWorkspace.displayName}` : 'MetaWork'; }, [activeWorkspace]);
  if (authenticated === null) {
    return <div className="token-gate"><div className="token-gate-card">正在连接 MetaWork…</div></div>;
  }
  if (!authenticated) return <TokenGate error={authError} onLogin={handleLogin} onTokenAuth={handleAuth} />;
  return (
    <>
      <WorkspaceShell
        sessions={sessions}
        hasMoreConversations={directoryCursor !== null}
        directoryLoading={directoryLoading}
        onLoadMoreConversations={() => void handleLoadMoreConversations()}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        activeSessionId={activeSessionId}
        selectedSessionId={selectedId}
        workspaceSwitching={workspaceSwitching}
        search={search}
        title={selectedMetadata?.title ?? activeWorkspace?.displayName ?? 'Workspace'}
        workspace={activeWorkspace}
        tab={tab}
        connected={connected}
        themePreference={themePreference}
        composerVisible={tab === 'conversation' && Boolean(selectedId)}
        draft={draft}
        composerDisabled={workspaceSwitching || composerDisabled}
        newWorkBlocked={requiredBlock.blocked}
        agentReadiness={agentReadiness}
        running={running}
        blockedReason={composerBlockedReason}
        previewOpen={previewState.status !== 'closed' || executionDetailOpen}
        previewMaximized={previewMaximized}
        previewDrawer={executionDetailOpen && executionDetail && executionDetailTurn && observationClient && httpRef.current && selectedId ? (
          <ObservedExecutionDetail
            conversationId={selectedId} initial={executionDetailTurn}
            ws={observationClient} http={httpRef.current}
            subtaskId={executionDetail.subtaskId}
            onClose={() => setExecutionDetail(null)}
          />
        ) : (
          <ArtifactPreviewDrawer
            http={httpRef.current}
            state={previewState}
            collapsed={previewCollapsed}
            maximized={previewMaximized}
            width={previewWidth}
            onClose={() => {
              setPreviewState({ status: 'closed' });
              setPreviewCollapsed(false);
              setPreviewMaximized(false);
            }}
            onToggleCollapse={() => setPreviewCollapsed(current => !current)}
            onToggleMaximize={() => setPreviewMaximized(current => !current)}
            onResize={next => setPreviewWidth(clampPreviewWidth(next))}
          />
        )}
        onSearch={setSearch}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={() => setWorkspaceCreatorOpen(true)}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onDeleteSession={sessionId => void handleDeleteSession(sessionId)}
        onClearSessions={() => void handleClearSessions()}
        onSettings={handleOpenAgentSettings}
        onRefreshAgentReadiness={handleRefreshAgentReadiness}
        onTabChange={nextTab => {
          if (nextTab === 'trajectory') setSelectedTrajectoryTurnId(null);
          setTab(nextTab);
        }}
        onThemeChange={setThemePreference}
        onDraftChange={handleDraftChange}
        onSend={handleSend}
        onCancelTurn={handleCancelTurn}
        attachments={pendingAttachments.map(metadata => ({ metadata }))}
        uploadError={uploadError}
        onFilesSelected={files => void handleFilesSelected(files)}
        onRemoveAttachment={handleRemoveAttachment}
      >
        {failedInput && <button onClick={handleRestoreFailedInput}>恢复发送失败的内容</button>}
        {!selectedId
          ? (
            <div className="workspace-home">
              <span className="workspace-home-kicker">WORKSPACE HOME</span>
              <h2>{activeWorkspace?.displayName ?? '选择一个 Workspace'}</h2>
              <p>
                {activeWorkspace
                  ? '选择左侧会话继续工作，或在当前 Workspace 新建一个独立会话。'
                  : '点击左侧添加按钮或此处按钮，选择本机目录创建 Workspace。'}
              </p>
              {activeWorkspace ? (
                <button
                  onClick={() => void handleNewSession()}
                  disabled={requiredBlock.blocked}
                >
                  新建会话
                </button>
              ) : (
                <button onClick={() => setWorkspaceCreatorOpen(true)}>添加 Workspace</button>
              )}
            </div>
          )
          : tab === 'conversation'
          ? (
            observationClient && httpRef.current && <ObservedConversationView
              key={selectedId}
              conversationId={selectedId}
              ws={observationClient}
              http={httpRef.current}
              memory={viewportMemory.current}
              initialTurnId={route?.conversationId === selectedId ? route.turnId : undefined}
              initialTaskId={route?.conversationId === selectedId ? route.taskId : undefined}
              onOpenTrajectory={openTrajectory}
              onOpenBilling={openBilling}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(turn, subtaskId, subtaskTitle) => setExecutionDetail({ turn, turnId: turn.id, subtaskId, subtaskTitle })}
            />
          )
          : (
            observationClient && httpRef.current && (tab === 'billing' ? selectedBillingTurn : selectedTrajectoryTurn) && <ObservedTurnDetails
              key={`${selectedId}:${tab}:${(tab === 'billing' ? selectedBillingTurn : selectedTrajectoryTurn)!.id}`}
              conversationId={selectedId}
              turnId={(tab === 'billing' ? selectedBillingTurn : selectedTrajectoryTurn)!.id}
              ws={observationClient} http={httpRef.current} tab={tab}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(turn, subtaskId) => setExecutionDetail({ turn, turnId: turn.id, subtaskId, subtaskTitle: '' })}
            />
          )}
      </WorkspaceShell>
      {settingsOpen && (
        <SettingsPanel
          http={httpRef.current}
          runtime={configurationRuntime}
          agentReadiness={agentReadiness}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {workspaceCreatorOpen && (
        <WorkspaceCreator
          http={httpRef.current}
          open
          disabled={workspaceSwitching}
          onClose={() => setWorkspaceCreatorOpen(false)}
          onSelect={handleCreateWorkspace}
        />
      )}
    </>
  );
}
function clampPreviewWidth(width: number): number {
  const viewport = typeof window === 'undefined' ? 1_440 : window.innerWidth;
  const max = Math.max(360, Math.min(viewport - 360, 1_200));
  return Math.round(Math.max(320, Math.min(width, max)));
}
import { useEffect } from 'react';
