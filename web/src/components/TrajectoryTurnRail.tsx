import { useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import { useConversationTurn, useConversationWindow } from '../observation/use-conversation';

/**
 * Turn switcher for the trajectory surface.
 *
 * Opening the trajectory tab used to leave the reader on the newest Turn with no
 * way to reach another one: ten Turns in a conversation still showed one trace.
 * This rail lists the Turns the client already knows, marks the one being read,
 * and can page further back through the locate endpoint without mutating the
 * bounded conversation window.
 *
 * Selecting a Turn is pure navigation: it never rewrites Turn facts, and a Turn
 * that is no longer in the store is still resolvable by identity downstream.
 */
export function TrajectoryTurnRail({
  conversationId,
  ws,
  http,
  selectedTurnId,
  onSelectTurn,
}: {
  conversationId: string;
  ws: WsClient;
  http: HttpClient | null;
  selectedTurnId: string;
  onSelectTurn: (turnId: string) => void;
}) {
  const window = useConversationWindow(ws.conversations, conversationId);
  const [olderIds, setOlderIds] = useState<string[]>([]);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = [...new Set([...olderIds, ...window.ids])];
  // Newest first: the reader usually starts at the current Turn and walks back.
  const ordered = [...ids].reverse();

  const loadOlder = async () => {
    if (!http || paging) return;
    const oldest = ids[0];
    if (!oldest) return;
    setPaging(true);
    try {
      const page = await http.locateConversationTurn(conversationId, oldest);
      const earlier = page.turns.map(turn => turn.id).filter(id => !ids.includes(id));
      setOlderIds(previous => [...new Set([...earlier, ...previous])]);
      setError(earlier.length === 0 ? '没有更早的轮次' : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPaging(false);
    }
  };

  if (ids.length === 0) return null;
  return (
    <nav className="trajectory-turn-rail" aria-label="轮次">
      <div className="trajectory-turn-rail-head">
        <span className="eyebrow">TURNS</span>
        <span>{ids.length} 轮</span>
      </div>
      <ol>
        {ordered.map(turnId => (
          <RailRow
            key={turnId}
            conversationId={conversationId}
            ws={ws}
            turnId={turnId}
            active={turnId === selectedTurnId}
            onSelect={onSelectTurn}
          />
        ))}
      </ol>
      <div className="trajectory-turn-rail-more">
        <button type="button" onClick={() => void loadOlder()} disabled={paging}>
          {paging ? '正在读取更早的轮次…' : '更早的轮次'}
        </button>
        {error && <small role="status">{error}</small>}
      </div>
    </nav>
  );
}

function RailRow({
  conversationId,
  ws,
  turnId,
  active,
  onSelect,
}: {
  conversationId: string;
  ws: WsClient;
  turnId: string;
  active: boolean;
  onSelect: (turnId: string) => void;
}) {
  const turn = useConversationTurn(ws.conversations, conversationId, turnId);
  const label = turn?.userInput?.trim() || '（无输入）';
  const when = turn?.startedAt ? new Date(turn.startedAt) : null;
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(turnId)}
      >
        <span className="trajectory-turn-rail-time">
          {when && !Number.isNaN(when.getTime())
            ? when.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : turnId.slice(-6)}
        </span>
        <span className="trajectory-turn-rail-label" title={label}>{label}</span>
        <span className="trajectory-turn-rail-status" data-status={turn?.status ?? 'unknown'}>
          {turn?.taskId ? '任务' : '对话'}
        </span>
      </button>
    </li>
  );
}
