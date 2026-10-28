import { TaskResultActions } from '../components/TaskResultActions';
import { BlockedActions } from '../components/BlockedActions';
import { WorkspaceChangesCard } from '../components/WorkspaceChangesCard';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import type { ConversationEntityStore } from './conversation-store';
import { useConversationTurn, useConversationWindow } from './use-conversation';
import { turnProjection } from './turn-projection';
import { ConversationTurnView } from '../components/ConversationTurn';
import { useCompleteContent } from './use-complete-content';
import { useTurnPresentation } from './use-turn-presentation';
import { LiveExecutionPanel } from '../components/LiveExecutionPanel';
import { LivePlanningPanel, plannerActivity } from '../components/LivePlanningPanel';
import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { desktopBridge, reportPersistenceError } from '../platform/services';

interface Anchor { turnId: string; offset: number; bottom: boolean }
export interface ConversationViewportMemory {
  anchors: Map<string, Anchor>;
  heights: Map<string, number>;
}

/** A small amount of slack keeps a user at the tail while a stream grows. */
const FOLLOW_LATEST_THRESHOLD = 64;

/** Visible rows subscribe individually; the list only observes membership and freshness. */
export const ObservedConversationView = memo(function ObservedConversationView({ conversationId, ws, http, memory, initialTurnId, initialTaskId, onOpenTrajectory, onOpenBilling, onOpenArtifact, onOpenAttachment, onOpenSubtaskDetail }: {
  conversationId: string; ws: WsClient; http: HttpClient; memory: ConversationViewportMemory;
  initialTurnId?: string;
  initialTaskId?: string;
  onOpenTrajectory(turnId: string): void; onOpenBilling(turnId: string): void;
  onOpenArtifact(artifact: ArtifactProjection): void;
  onOpenAttachment?: (conversationId: string, attachment: import('../api/session-types').ConversationAttachment) => void;
  onOpenSubtaskDetail(turn: ConversationTurnProjection, subtaskId: string, title: string): void;
}) {
  const store = ws.conversations;
  const window = useConversationWindow(store, conversationId);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: -1, height: 900 });
  const [measurement, setMeasurement] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoadAttempt, setInitialLoadAttempt] = useState(0);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const initialLocated = useRef<string | null>(null);
  const anchor = useRef<Anchor | null>(memory.anchors.get(conversationId) ?? null);
  const followLatest = useRef(anchor.current?.bottom !== false);
  const [followingLatest, setFollowingLatest] = useState(followLatest.current);
  // Ignore the first ResizeObserver pass. It runs before a persisted anchor's
  // full Turn body is measured and must not overwrite the saved offset.
  const programmaticScroll = useRef(true);
  const programmaticScrollUntil = useRef(Number.POSITIVE_INFINITY);
  const programmaticReleaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  // Once a user leaves the tail, preserve the row they are reading. A row's
  // own streamed body may grow freely; only movement of a preceding row needs
  // a compensating scrollTop adjustment.
  const reading = useRef(false);
  const readingRowTop = useRef<number | null>(null);
  const readingListTop = useRef<number | null>(null);
  const readingGesturePending = useRef(false);
  const pendingUserScrollDirection = useRef<'up' | 'down' | null>(null);
  const lastObservedScrollTop = useRef<number | null>(null);
  const lastTouchY = useRef<number | null>(null);
  const positions = useMemo(() => {
    let y = 0;
    return window.ids.map(id => {
      const height = memory.heights.get(`${conversationId}\0${id}`) ?? 280;
      const position = { id, top: y, height }; y += height; return position;
    });
  }, [window.ids, memory, conversationId, measurement]);
  const positionsRef = useRef(positions); positionsRef.current = positions;
  const total = positions.at(-1) ? positions.at(-1)!.top + positions.at(-1)!.height : 0;
  const restored = anchor.current && !anchor.current.bottom
    ? positions.find(row => row.id === anchor.current?.turnId) : null;
  const requestedTop = viewport.top < 0
    ? restored ? restored.top + (anchor.current?.offset ?? 0) : Math.max(0, total - viewport.height)
    : viewport.top;
  // Desktop persists the Turn-relative offset, but measured heights are local
  // to this document. Mount the anchor even when its estimate is shorter than
  // the saved offset so it can measure and fetch its complete report body.
  const visibleTop = Math.max(0, Math.min(requestedTop, total - viewport.height));
  const visible = positions.filter(row => row.id === restored?.id || pinned.has(row.id)
    || (row.top + row.height >= visibleTop - 700 && row.top <= visibleTop + viewport.height + 700));
  const measure = useCallback((id: string, height: number) => {
    const key = `${conversationId}\0${id}`;
    if (height > 0 && Math.abs((memory.heights.get(key) ?? 280) - height) > 1) {
      memory.heights.delete(key); memory.heights.set(key, height);
      while (memory.heights.size > 1000) memory.heights.delete(memory.heights.keys().next().value!);
      setMeasurement(value => value + 1);
    }
  }, [memory, conversationId]);

  useEffect(() => {
    const idFor = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return element && root.current?.contains(element) ? element.closest<HTMLElement>('[data-observed-turn]')?.dataset.observedTurn : undefined;
    };
    const update = () => {
      const selection = document.getSelection();
      const ids = new Set<string>();
      const focused = idFor(document.activeElement); if (focused) ids.add(focused);
      if (selection && !selection.isCollapsed) {
        const start = positionsRef.current.findIndex(row => row.id === idFor(selection.anchorNode));
        const end = positionsRef.current.findIndex(row => row.id === idFor(selection.focusNode));
        if (start >= 0 && end >= 0) for (const row of positionsRef.current.slice(Math.min(start, end), Math.max(start, end) + 1)) ids.add(row.id);
      }
      setPinned(previous => previous.size === ids.size && [...ids].every(id => previous.has(id)) ? previous : ids);
    };
    document.addEventListener('selectionchange', update); document.addEventListener('focusin', update);
    return () => { document.removeEventListener('selectionchange', update); document.removeEventListener('focusin', update); };
  }, [conversationId]);

  useEffect(() => {
    const canvas = root.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas) return;
    const previousOverflowAnchor = canvas.style.overflowAnchor;
    // The virtual list owns anchoring. Native scroll anchoring can otherwise
    // move the viewport while a streamed Turn grows, fighting our saved Turn
    // offset and producing the visible jitter reported by users.
    canvas.style.overflowAnchor = 'none';
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const listTop = () => list.current
      ? list.current.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop
      : 0;
    const setFollowLatest = (value: boolean) => {
      if (followLatest.current === value) return;
      followLatest.current = value;
      setFollowingLatest(value);
    };
    const detachFromLatest = (direction: 'up' | 'down') => {
      // Detach synchronously from the input gesture. Waiting for the browser's
      // following `scroll` event leaves a race with a streamed React render:
      // the layout effect can otherwise write the tail position back before
      // the user scroll event is processed.
      programmaticScroll.current = false;
      programmaticScrollUntil.current = 0;
      if (programmaticReleaseTimer.current) {
        clearTimeout(programmaticReleaseTimer.current);
        programmaticReleaseTimer.current = undefined;
      }
      reading.current = true;
      readingGesturePending.current = true;
      readingRowTop.current = null;
      readingListTop.current = null;
      pendingUserScrollDirection.current = direction;
      setFollowLatest(false);
    };
    const update = () => {
      frame = 0;
      if (programmaticScroll.current) {
        if (Date.now() < programmaticScrollUntil.current) return;
        programmaticScroll.current = false;
      }
      readingGesturePending.current = false;
      const scrollDelta = lastObservedScrollTop.current === null
        ? 0 : canvas.scrollTop - lastObservedScrollTop.current;
      const direction = pendingUserScrollDirection.current
        ?? (scrollDelta < -1 ? 'up' : scrollDelta > 1 ? 'down' : null);
      pendingUserScrollDirection.current = null;
      lastObservedScrollTop.current = canvas.scrollTop;
      const relativeTop = Math.max(0, canvas.scrollTop - listTop());
      const distanceFromBottom = Math.max(0, canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight);
      const shouldFollowLatest = direction === 'up' ? false
        : direction === 'down' ? distanceFromBottom <= FOLLOW_LATEST_THRESHOLD
          : followLatest.current && distanceFromBottom <= FOLLOW_LATEST_THRESHOLD;
      setFollowLatest(shouldFollowLatest);
      setViewport({ top: relativeTop, height: canvas.clientHeight });
      const row = positionsRef.current.find(item => item.top + item.height >= relativeTop);
      if (row) {
        reading.current = !shouldFollowLatest;
        readingRowTop.current = shouldFollowLatest ? null : row.top;
        readingListTop.current = shouldFollowLatest ? null : listTop();
        anchor.current = { turnId: row.id, offset: relativeTop - row.top,
          bottom: shouldFollowLatest };
        memory.anchors.delete(conversationId); memory.anchors.set(conversationId, anchor.current);
        while (memory.anchors.size > 64) memory.anchors.delete(memory.anchors.keys().next().value!);
        if (desktopBridge()) {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            void desktopBridge()!.setViewport(conversationId, anchor.current).catch(reportPersistenceError);
          }, 250);
        }
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const userScroll = (event: Event) => {
      // Wheel, touch and keyboard intent arrives before the browser emits its
      // resulting scroll event. Detach immediately so a concurrent stream
      // update cannot win the race and pull the viewport back to the tail.
      const key = event instanceof KeyboardEvent ? event.key : '';
      const wheelDirection = event instanceof WheelEvent && event.deltaY !== 0
        ? event.deltaY < 0 ? 'up' : 'down' : null;
      const keyDirection = event instanceof KeyboardEvent
        ? ['ArrowUp', 'PageUp', 'Home'].includes(key) ? 'up'
          : ['ArrowDown', 'PageDown', 'End'].includes(key) ? 'down' : null
        : null;
      if (event.type === 'touchstart' && event instanceof TouchEvent) {
        lastTouchY.current = event.touches[0]?.clientY ?? null;
      }
      let touchDirection: 'up' | 'down' | null = null;
      if (event.type === 'touchmove' && event instanceof TouchEvent) {
        const currentY = event.touches[0]?.clientY;
        if (currentY !== undefined && lastTouchY.current !== null && currentY !== lastTouchY.current) {
          touchDirection = currentY > lastTouchY.current ? 'up' : 'down';
        }
        if (currentY !== undefined) lastTouchY.current = currentY;
      }
      const direction = wheelDirection ?? keyDirection ?? touchDirection;
      if (direction !== null && (direction === 'up' || reading.current)) {
        detachFromLatest(direction);
      }
    };
    canvas.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown']) {
      canvas.addEventListener(type, userScroll, { passive: true, capture: true });
    }
    const observer = new ResizeObserver(onScroll); observer.observe(canvas);
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      if (programmaticReleaseTimer.current) clearTimeout(programmaticReleaseTimer.current);
      canvas.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown']) {
        canvas.removeEventListener(type, userScroll, { capture: true });
      }
      observer.disconnect(); cancelAnimationFrame(frame);
      canvas.style.overflowAnchor = previousOverflowAnchor;
    };
  }, [conversationId, memory]);

  useLayoutEffect(() => {
    const canvas = root.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas || !positions.length) return;
    const saved = anchor.current;
    const row = saved && positions.find(item => item.id === saved.turnId);
    if (!followLatest.current && reading.current) {
      // Wait for the scroll event to commit a pending wheel/touch/key gesture;
      // the previous reading anchor belongs to a different viewport position.
      if (readingGesturePending.current || !row || readingRowTop.current === null) return;
      const precedingShift = row.top - readingRowTop.current;
      const listTop = list.current
        ? list.current.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop
        : 0;
      const listShift = readingListTop.current === null ? 0 : listTop - readingListTop.current;
      const totalShift = precedingShift + listShift;
      if (Math.abs(totalShift) <= 1) return;
      const target = Math.max(0, canvas.scrollTop + totalShift);
      readingRowTop.current = row.top;
      readingListTop.current = listTop;
      if (Math.abs(canvas.scrollTop - target) > 1) {
        programmaticScroll.current = true;
        programmaticScrollUntil.current = Date.now() + 250;
        const previousScrollBehavior = canvas.style.scrollBehavior;
        canvas.style.scrollBehavior = 'auto';
        canvas.scrollTop = target;
        lastObservedScrollTop.current = canvas.scrollTop;
        canvas.style.scrollBehavior = previousScrollBehavior;
        if (programmaticReleaseTimer.current) clearTimeout(programmaticReleaseTimer.current);
        programmaticReleaseTimer.current = setTimeout(() => {
          programmaticScroll.current = false;
          programmaticScrollUntil.current = 0;
        }, 250);
      }
      return;
    }
    const requestedTop = followLatest.current
      ? Math.max(0, total - canvas.clientHeight)
      : row ? Math.max(0, row.top + saved.offset) : Math.max(0, viewport.top);
    // Clamp the rendered position while preserving the desired anchor: later
    // body/height updates can restore it, and stale offsets cannot show a void.
    const top = Math.max(0, Math.min(requestedTop, total - canvas.clientHeight));
    const listTop = list.current ? list.current.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop : 0;
    // The measured row can be taller than the virtual estimate (for example a
    // streamed markdown report). In follow mode the browser's scrollHeight is
    // the authoritative tail; the estimate can leave the viewport visibly
    // above the latest output and incorrectly show the return button.
    const targetScrollTop = followLatest.current
      ? Math.max(0, canvas.scrollHeight - canvas.clientHeight)
      : listTop + top;
    // In reading mode, only adjust when a preceding row moved. Avoid writing
    // scrollTop on every streamed height update; that write is what causes the
    // viewport to fight the user's wheel gesture.
    if (Math.abs(canvas.scrollTop - targetScrollTop) > 1) {
      programmaticScroll.current = true;
      programmaticScrollUntil.current = Date.now() + 250;
      // Internal layout corrections must be immediate; animating every row
      // measurement makes the virtual list chase a moving target.
      const previousScrollBehavior = canvas.style.scrollBehavior;
      canvas.style.scrollBehavior = 'auto';
      canvas.scrollTop = targetScrollTop;
      lastObservedScrollTop.current = targetScrollTop;
      canvas.style.scrollBehavior = previousScrollBehavior;
      if (programmaticReleaseTimer.current) clearTimeout(programmaticReleaseTimer.current);
      programmaticReleaseTimer.current = setTimeout(() => {
        programmaticScroll.current = false;
        programmaticScrollUntil.current = 0;
      }, 250);
    } else if (programmaticScroll.current && !(saved && !saved.bottom)) {
      programmaticScroll.current = false;
      programmaticScrollUntil.current = 0;
    }
    // Use the virtual coordinates until measured rows settle. Reading scrollHeight
    // here can select an empty window when a newly mounted row is much taller than its estimate.
    setViewport(previous => Math.abs(previous.top - top) > 1 || previous.height !== canvas.clientHeight
      ? { top, height: canvas.clientHeight } : previous);
  }, [positions, total, viewport.top]);

  const returnToLatest = useCallback(() => {
    followLatest.current = true;
    reading.current = false;
    readingRowTop.current = null;
    readingListTop.current = null;
    readingGesturePending.current = false;
    pendingUserScrollDirection.current = null;
    setFollowingLatest(true);
    const latestId = window.ids.at(-1);
    if (latestId) {
      const latestAnchor: Anchor = { turnId: latestId, offset: 0, bottom: true };
      anchor.current = latestAnchor;
      memory.anchors.delete(conversationId);
      memory.anchors.set(conversationId, latestAnchor);
      while (memory.anchors.size > 64) memory.anchors.delete(memory.anchors.keys().next().value!);
      if (desktopBridge()) {
        void desktopBridge()!.setViewport(conversationId, latestAnchor).catch(reportPersistenceError);
      }
    } else {
      anchor.current = null;
    }
    const canvas = root.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas) return;
    lastObservedScrollTop.current = canvas.scrollTop;
    programmaticScroll.current = true;
    programmaticScrollUntil.current = Date.now() + 700;
    if (programmaticReleaseTimer.current) clearTimeout(programmaticReleaseTimer.current);
    programmaticReleaseTimer.current = setTimeout(() => {
      programmaticScroll.current = false;
      programmaticScrollUntil.current = 0;
    }, 700);
    canvas.scrollTo({ top: canvas.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [conversationId, memory, window.ids]);

  const loadOlder = async () => {
    if (!window.olderCursor || !window.cursor || loading) return;
    const epoch = window.cursor.epoch; const generation = store.currentGeneration();
    setLoading(true); setError(null);
    try { store.older(conversationId, await http.getConversationView(conversationId, undefined, window.ids[0]), epoch, generation); }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    let active = true;
    setError(null);
    const current = store.window(conversationId);
    if (current.status === 'ready' && current.cursor) return () => { active = false; };
    void http.getConversationView(conversationId).then(page => {
      if (!active) return;
      store.hydrate(conversationId, page);
    }).catch(reason => {
      if (!active) return;
      setError(`历史加载失败：${(reason as Error).message}`);
    });
    return () => { active = false; };
  }, [conversationId, http, initialLoadAttempt, store]);

  useEffect(() => {
    if (window.status === 'ready') setError(null);
  }, [window.status]);

  const locate = async (turnId: string, taskId?: string) => {
    const generation = store.currentGeneration(); const epoch = window.cursor?.epoch;
    if (!epoch) return;
    const page = await http.locateConversationTurn(conversationId, turnId, taskId);
    if (generation !== store.currentGeneration() || epoch !== store.window(conversationId).cursor?.epoch) return;
    anchor.current = { turnId: page.turns.at(-1)?.id ?? turnId, offset: 0, bottom: false };
    store.locate(conversationId, page, epoch, generation);
  };

  useEffect(() => {
    const target = initialTurnId ?? initialTaskId;
    if (!target || !window.cursor || initialLocated.current === target) return;
    initialLocated.current = target;
    void locate(initialTurnId ?? '', initialTurnId ? undefined : initialTaskId).catch(error => setError((error as Error).message));
  }, [initialTurnId, initialTaskId, window.cursor?.epoch]);

  const statusMessage = error ?? window.error ?? {
      loading: '正在读取会话…', preparing: '正在整理历史，已有内容可先浏览。', disconnected: '连接已断开，正在重连…', error: '会话暂时不可用。', ready: '',
    }[window.status];
  return <div className="conversation-view" ref={root} style={{ overflowAnchor: 'none' }}>
    {(window.status !== 'ready' || error) && <div className="conversation-state" role={error ? 'alert' : 'status'}>
      <p>{statusMessage}</p>
      {error && <button type="button" onClick={() => setInitialLoadAttempt(value => value + 1)}>重新加载</button>}
    </div>}
    {window.olderCursor && <button disabled={loading} onClick={() => void loadOlder()}>{loading ? '正在加载…' : '加载更早的对话'}</button>}
    {!window.atLatest && <button type="button" onClick={() => { anchor.current = null; ws.observations.latest(conversationId); }}>返回最新对话</button>}
    {!window.ids.length && window.status === 'ready' && <div className="workspace-empty"><h2>还没有对话内容</h2><p>在下方输入你的目标，开始这个任务。</p></div>}
    <div ref={list}>
    {visible.map((row, index) => <Fragment key={row.id}>
      <div style={{ height: Math.max(0, row.top - (index ? visible[index - 1]!.top + visible[index - 1]!.height : 0)) }} aria-hidden />
      <ObservedTurn id={row.id} conversationId={conversationId} store={store} ws={ws}
        latest={row.id === window.ids.at(-1)}
        http={http} measure={measure} onOpenTrajectory={onOpenTrajectory} onOpenBilling={onOpenBilling}
        onOpenArtifact={onOpenArtifact} onOpenAttachment={onOpenAttachment} onOpenSubtaskDetail={onOpenSubtaskDetail} />
    </Fragment>)}
    <div style={{ height: Math.max(0, total - (visible.at(-1) ? visible.at(-1)!.top + visible.at(-1)!.height : 0)) }} aria-hidden />
    </div>
    {!followingLatest && <button type="button" className="back-to-latest" aria-label="回到最新输出" onClick={returnToLatest}>
      ↓ 回到最新
    </button>}
  </div>;
});

const ObservedTurn = memo(function ObservedTurn({ store, conversationId, id, http, ws, latest, measure, onOpenTrajectory, onOpenBilling, onOpenArtifact, onOpenAttachment, onOpenSubtaskDetail }: {
  store: ConversationEntityStore; conversationId: string; id: string; http: HttpClient; ws: WsClient; latest: boolean;
  onOpenArtifact(artifact: ArtifactProjection): void;
  onOpenAttachment?: (conversationId: string, attachment: import('../api/session-types').ConversationAttachment) => void;
  onOpenSubtaskDetail(turn: ConversationTurnProjection, subtaskId: string, title: string): void;
  measure(id: string, height: number): void; onOpenTrajectory(id: string): void; onOpenBilling(id: string): void;
}) {
  const turn = useConversationTurn(store, conversationId, id);
  const root = useRef<HTMLDivElement>(null);
  const answer = useCompleteContent(http, store, conversationId, turn?.answerRef, turn?.answer ?? '');
  const prompt = useCompleteContent(http, store, conversationId, turn?.userInputRef, turn?.userInput ?? '');
  const showExecution = latest || turn?.status === 'running' || turn?.status === 'blocked';
  const details = useTurnPresentation(ws, http, conversationId, turn, showExecution);
  useLayoutEffect(() => {
    const node = root.current; if (!node) return;
    measure(id, node.getBoundingClientRect().height);
    const observer = new ResizeObserver(() => measure(id, node.getBoundingClientRect().height));
    observer.observe(node); return () => observer.disconnect();
  }, [measure, id]);
  const projection = useMemo(() => {
    if (!turn) return null;
    const value = { ...turnProjection(turn), ...details };
    value.finalAnswer = answer.text || null;
    value.userInput = prompt.text;
    return value;
  }, [turn, answer.text, prompt.text, details]);
  if (!turn || !projection) return null;
  return <div ref={root} data-observed-turn={id}>
    <ConversationTurnView turn={projection} onOpenTrajectory={onOpenTrajectory} onOpenBilling={onOpenBilling}
      onOpenArtifact={onOpenArtifact} onOpenAttachment={onOpenAttachment}
      liveExecutionPanel={showExecution ? (plannerActivity(projection)
        ? <LivePlanningPanel turn={projection} />
        : <LiveExecutionPanel turn={projection} onSelectSubtask={(subtaskId, title) => onOpenSubtaskDetail(projection, subtaskId, title)} />) : undefined}
      blockedActions={<BlockedActions ws={ws} http={http} conversationId={conversationId} taskId={turn.taskId ?? null}
        fallbackStatus={projection.status === 'blocked' || projection.status === 'failed' ? projection.status : null}
        lifecycle={details.taskLifecycle} permission={details.pendingPermission} refresh={details.refresh} />} />
    <TaskResultActions delivery={details.publicDelivery} workspaceChanges={details.workspaceChanges} />
    {details.workspaceChanges && (
      <WorkspaceChangesCard changes={details.workspaceChanges} delivered={details.publicDelivery?.files ?? []} />
    )}
    {(answer.error || prompt.error) && <p role="alert">{answer.error ?? prompt.error}</p>}
  </div>;
});
