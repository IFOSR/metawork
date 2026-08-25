import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { ExecutionNarrative } from './ExecutionNarrative';
import { MarkdownContent } from './MarkdownContent';
import { ArtifactLink } from './ArtifactLink';

export function ConversationTurnView({
  turn,
  onOpenArtifact,
}: {
  turn: ConversationTurnProjection;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
}) {
  // 历史会话记录可能没有 artifacts 字段；防御性兜底避免整树卸载。
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  return (
    <article className="conversation-turn" data-turn-id={turn.id}>
      <section className="user-message">
        <span>YOU</span>
        <p>{turn.userInput}</p>
      </section>
      <ExecutionNarrative turn={turn} />
      {turn.status !== 'running' && turn.finalAnswer && (
        <section className="final-answer">
          <MarkdownContent value={turn.finalAnswer} />
        </section>
      )}
      {turn.status !== 'running' && onOpenArtifact && artifacts.length > 0 && (
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
