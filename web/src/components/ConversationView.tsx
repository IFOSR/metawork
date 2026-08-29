import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { ConversationTurnView } from './ConversationTurn';
import { LiveExecutionPanel } from './LiveExecutionPanel';

export function ConversationView({
  sessionId,
  turns,
  running = false,
  onOpenArtifact,
  onOpenSubtaskDetail,
}: {
  sessionId?: string | null;
  turns: ConversationTurnProjection[];
  running?: boolean;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenSubtaskDetail?: (subtaskId: string, subtaskTitle: string) => void;
}) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const previousSessionIdRef = useRef<string | null | undefined>(sessionId);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const canvas = viewRef.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas) return;
    canvas.scrollTo({ top: canvas.scrollHeight, behavior });
  }, []);

  const unlock = useCallback(() => {
    lockedRef.current = false;
    setLocked(false);
  }, []);

  const lock = useCallback(() => {
    lockedRef.current = true;
    setLocked(true);
  }, []);

  // 点击锁定视野；手动滚回底部自动解锁，恢复跟随。
  useEffect(() => {
    const canvas = viewRef.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas) return;
    const onPointerDown = () => lock();
    const onScroll = () => {
      const distanceFromBottom = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
      if (distanceFromBottom < 40 && lockedRef.current) unlock();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('scroll', onScroll);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('scroll', onScroll);
    };
  }, [lock, unlock]);

  // 流式新内容跟随底部；切换会话强制到底并解锁；锁定后不再跟随。
  useEffect(() => {
    const canvas = viewRef.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas) {
      // 历史记录异步加载时先经过空状态；下一次真正挂载内容时应视为首次进入。
      previousSessionIdRef.current = null;
      return;
    }

    const switchedSession = previousSessionIdRef.current !== sessionId;
    const distanceFromBottom = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
    const nearBottom = distanceFromBottom < 160;
    if (switchedSession) {
      unlock();
      scrollToBottom('auto');
    } else if (!lockedRef.current && nearBottom) {
      scrollToBottom('auto');
    }
    previousSessionIdRef.current = sessionId;
  }, [sessionId, turns, scrollToBottom, unlock]);

  if (turns.length === 0) {
    return (
      <div className="workspace-empty">
        <span>READY</span>
        <h2>从一个明确目标开始</h2>
        <p>Planner、Kernel 与 Executor 的安全执行步骤会按发生顺序显示在这里。</p>
      </div>
    );
  }
  const latest = turns.at(-1);
  return (
    <div className="conversation-view" ref={viewRef}>
      {turns.map(turn => (
        <ConversationTurnView
          turn={turn}
          key={turn.id}
          liveExecutionPanel={turn.id === latest?.id && latest ? (
            <LiveExecutionPanel turn={latest} onSelectSubtask={onOpenSubtaskDetail} />
          ) : undefined}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
      {locked && (
        <button
          type="button"
          className="back-to-latest"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => {
            unlock();
            scrollToBottom('smooth');
          }}
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}
