import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import type { ReactNode } from 'react';
import { ExecutionNarrative } from './ExecutionNarrative';
import { ArtifactAwareMarkdownContent } from './ArtifactAwareMarkdownContent';
import { ArtifactLink } from './ArtifactLink';

export function ConversationTurnView({
  turn,
  liveExecutionPanel,
  onOpenArtifact,
}: {
  turn: ConversationTurnProjection;
  liveExecutionPanel?: ReactNode;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
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
  return (
    <article className="conversation-turn" data-turn-id={turn.id}>
      <section className="user-message">
        <span>YOU</span>
        <p>{turn.userInput}</p>
      </section>
      {liveExecutionPanel}
      {(!isSystemCommand || hasTaskExecution) && <ExecutionNarrative turn={turn} />}
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
