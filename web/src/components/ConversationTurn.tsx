import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import type { ReactNode } from 'react';
import { ArtifactAwareMarkdownContent } from './ArtifactAwareMarkdownContent';
import { ArtifactLink } from './ArtifactLink';

function executionStatusLabel(status: ConversationTurnProjection['status']): string {
  if (status === 'running') return '执行中';
  if (status === 'blocked') return '已阻塞';
  if (status === 'failed') return '失败';
  return '已完成';
}

export function ConversationTurnView({
  turn,
  liveExecutionPanel,
  onOpenArtifact,
  onOpenTrajectory,
}: {
  turn: ConversationTurnProjection;
  liveExecutionPanel?: ReactNode;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenTrajectory?: (turnId: string) => void;
}) {
  // 历史会话记录可能没有 artifacts 字段；防御性兜底避免整树卸载。
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  const isSystemCommand = turn.interactionKind === 'system_command'
    || turn.userInput.trim().startsWith('/');
  const hasTaskExecution = Boolean(
    turn.taskId
      || turn.executionTimeline
      || turn.traceEvents.some(event => event.taskId || event.phase === 'execution'),
  );
  const stepCount = turn.traceEvents.length;
  return (
    <article className="conversation-turn" data-turn-id={turn.id}>
      <section className="user-message">
        <span>YOU</span>
        <p>{turn.userInput}</p>
      </section>
      {liveExecutionPanel}
      {(!isSystemCommand || hasTaskExecution) && hasTaskExecution && (
        <section className="execution-status-line" data-status={turn.status}>
          <span>{executionStatusLabel(turn.status)}{stepCount > 0 ? ` · ${stepCount} 步` : ''}</span>
          {onOpenTrajectory && (
            <button
              type="button"
              className="trajectory-link"
              onClick={() => onOpenTrajectory(turn.id)}
            >
              查看完整轨迹 →
            </button>
          )}
        </section>
      )}
      {isSystemCommand && turn.finalAnswer && (
        <section className="system-command-result">
          <header><span>COMMAND RESULT</span></header>
          <ArtifactAwareMarkdownContent
            value={turn.finalAnswer}
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
          />
        </section>
      )}
      {!isSystemCommand && turn.status !== 'running' && turn.finalAnswer && (
        <section className="final-answer">
          <ArtifactAwareMarkdownContent
            value={turn.finalAnswer}
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
          />
        </section>
      )}
      {onOpenArtifact && artifacts.length > 0 && (
        <section className="turn-artifacts" aria-label="任务产物">
          <header><span>ARTIFACTS</span></header>
          <div className="artifact-link-list">
            {artifacts.map(artifact => (
              <ArtifactLink
                artifact={artifact}
                onOpen={() => onOpenArtifact(artifact)}
                key={artifact.artifactId}
              />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
