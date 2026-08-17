import type { ConversationTurnProjection } from '../api/session-types';
import { ExecutionNarrative } from './ExecutionNarrative';
import { MarkdownContent } from './MarkdownContent';

export function ConversationTurnView({ turn }: { turn: ConversationTurnProjection }) {
  return (
    <article className="conversation-turn">
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
    </article>
  );
}
