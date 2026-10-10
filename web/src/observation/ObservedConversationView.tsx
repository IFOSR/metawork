import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import type { ConversationEntityStore } from './conversation-store';
import { useConversationActivity, useConversationTurn, useConversationWindow } from './use-conversation';
import { turnProjection } from './turn-projection';
import { ConversationTurnView } from '../components/ConversationTurn';
import { ObservedActivity } from './ObservedActivity';
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

/** Visible rows subscribe individually; the list only observes membership and freshness. */
export const ObservedConversationView = memo(function ObservedConversationView({ conversationId, ws, http, memory, initialTurnId, initialTaskId, onOpenTrajectory, onOpenBilling, onOpenArtifact, onOpenSubtaskDetail }: {
  conversationId: string; ws: WsClient; http: HttpClient; memory: ConversationViewportMemory;
  initialTurnId?: string;
  initialTaskId?: string;
  onOpenTrajectory(turnId: string): void; onOpenBilling(turnId: string): void;
  onOpenArtifact(artifact: ArtifactProjection): void;
  onOpenSubtaskDetail(turn: ConversationTurnProjection, subtaskId: string, title: string): void;
}) {
  const store = ws.conversations;
  const window = useConversationWindow(store, conversationId);
  const activity = useConversationActivity(store, conversationId);
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
  const programmaticScroll = useRef(true);
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
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      frame = 0;
      if (programmaticScroll.current) return;
      const relativeTop = Math.max(0, canvas.scrollTop - (list.current && canvas ? list.current.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop : 0));
      setViewport({ top: relativeTop, height: canvas.clientHeight });
      const row = positionsRef.current.find(item => item.top + item.height >= relativeTop);
      if (row && !programmaticScroll.current) {
        anchor.current = { turnId: row.id, offset: relativeTop - row.top,
          bottom: canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 48 };
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
    const userScroll = () => { programmaticScroll.current = false; };
    canvas.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) canvas.addEventListener(type, userScroll, { passive: true });
    const observer = new ResizeObserver(onScroll); observer.observe(canvas);
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      canvas.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) canvas.removeEventListener(type, userScroll);
      observer.disconnect(); cancelAnimationFrame(frame);
    };
  }, [conversationId, memory]);

  useLayoutEffect(() => {
    const canvas = root.current?.closest<HTMLElement>('.workspace-canvas');
    if (!canvas || !positions.length) return;
    programmaticScroll.current = true;
    const saved = anchor.current;
    const row = saved && positions.find(item => item.id === saved.turnId);
    const requestedTop = !saved || saved.bottom ? Math.max(0, total - canvas.clientHeight)
      : row ? Math.max(0, row.top + saved.offset) : Math.max(0, viewport.top);
    // Clamp the rendered position while preserving the desired anchor: later
    // body/height updates can restore it, and stale offsets cannot show a void.
    const top = Math.max(0, Math.min(requestedTop, total - canvas.clientHeight));
    const listTop = list.current ? list.current.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop : 0;
    canvas.scrollTop = listTop + top;
    // Use the virtual coordinates until measured rows settle. Reading scrollHeight
    // here can select an empty window when a newly mounted row is much taller than its estimate.
    setViewport({ top, height: canvas.clientHeight });
  }, [positions, total]);

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
    <ObservedActivity conversationId={conversationId} view={activity} ws={ws} http={http} showTasks={false} />
    {window.olderCursor && <button disabled={loading} onClick={() => void loadOlder()}>{loading ? '正在加载…' : '加载更早的对话'}</button>}
    {!window.atLatest && <button onClick={() => { anchor.current = null; ws.observations.latest(conversationId); }}>返回最新对话</button>}
    {!window.ids.length && window.status === 'ready' && <div className="workspace-empty"><h2>还没有对话内容</h2><p>在下方输入你的目标，开始这个任务。</p></div>}
    <div ref={list}>
    {visible.map((row, index) => <Fragment key={row.id}>
      <div style={{ height: Math.max(0, row.top - (index ? visible[index - 1]!.top + visible[index - 1]!.height : 0)) }} aria-hidden />
      <ObservedTurn id={row.id} conversationId={conversationId} store={store} ws={ws}
        latest={row.id === window.ids.at(-1)}
        http={http} measure={measure} onOpenTrajectory={onOpenTrajectory} onOpenBilling={onOpenBilling}
        onOpenArtifact={onOpenArtifact} onOpenSubtaskDetail={onOpenSubtaskDetail} />
    </Fragment>)}
    <div style={{ height: Math.max(0, total - (visible.at(-1) ? visible.at(-1)!.top + visible.at(-1)!.height : 0)) }} aria-hidden />
    </div>
    {anchor.current && !anchor.current.bottom && <button className="back-to-latest" onClick={() => {
      anchor.current = null; const canvas = root.current?.closest<HTMLElement>('.workspace-canvas');
      canvas?.scrollTo({ top: canvas.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }}>↓ 回到最新</button>}
  </div>;
});

const ObservedTurn = memo(function ObservedTurn({ store, conversationId, id, http, ws, latest, measure, onOpenTrajectory, onOpenBilling, onOpenArtifact, onOpenSubtaskDetail }: {
  store: ConversationEntityStore; conversationId: string; id: string; http: HttpClient; ws: WsClient; latest: boolean;
  onOpenArtifact(artifact: ArtifactProjection): void;
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
      onOpenArtifact={onOpenArtifact}
      liveExecutionPanel={showExecution ? (plannerActivity(projection)
        ? <LivePlanningPanel turn={projection} />
        : <LiveExecutionPanel turn={projection} onSelectSubtask={(subtaskId, title) => onOpenSubtaskDetail(projection, subtaskId, title)} />) : undefined} />
    {(answer.error || prompt.error) && <p role="alert">{answer.error ?? prompt.error}</p>}
  </div>;
});
