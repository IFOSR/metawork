import { useEffect, useState } from 'react';
import type { ConversationTurnView } from '../../../src/session/conversation-read-types';
import type { HttpClient } from '../api/http';

/**
 * Resolve one Turn for a detail surface, even when it left the bounded window.
 *
 * Conversation read models are intentionally bounded, so a Turn that was
 * scrolled past or evicted is no longer in the local store. Detail surfaces
 * (trajectory, execution drawer) address a Turn by id, so they must be able to
 * load it from the server instead of showing "reading turn…" forever.
 *
 * The store stays the source of truth: this is a fallback read, and it caches
 * nothing globally.
 */
export function useLocatedTurn(
  http: HttpClient | null,
  conversationId: string,
  turnId: string,
  summary: ConversationTurnView | undefined,
): { turn: ConversationTurnView | null; error: string | null; loading: boolean } {
  const [located, setLocated] = useState<{ turnId: string; turn: ConversationTurnView | null; error: string | null } | null>(null);

  useEffect(() => {
    if (summary || !http || !turnId) return;
    let active = true;
    void http.locateConversationTurn(conversationId, turnId)
      .then(page => {
        if (!active) return;
        const found = page.turns.find(turn => turn.id === turnId) ?? null;
        setLocated({ turnId, turn: found, error: found ? null : 'turn_not_found' });
      })
      .catch((reason: unknown) => {
        if (active) setLocated({ turnId, turn: null, error: (reason as Error).message });
      });
    return () => { active = false; };
  }, [conversationId, http, summary, turnId]);

  if (summary) return { turn: summary, error: null, loading: false };
  // A result for a previously addressed Turn never describes the current one.
  const current = located?.turnId === turnId ? located : null;
  return { turn: current?.turn ?? null, error: current?.error ?? null, loading: !current };
}
