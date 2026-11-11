import { useEffect, useMemo, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { InteractionTraceEvent } from '../api/types';

/**
 * Manager 规划详情：把 InteractionTrace 中已公开的 planning 里程碑投影成
 * 与 Executor 详情同形的抽屉。只展示阶段、工具名、参数字段名、耗时与提案
 * 结果——不展示 prompt、thinking 或工具参数值。
 */

const PLANNING_KIND_PREFIX = 'planner_';

const KIND_LABELS: Record<string, string> = {
  planner_started: '开始规划',
  planner_process_started: '启动 Manager 进程',
  planner_prompt_accepted: 'Manager 已接收请求',
  planner_agent_started: 'Manager 开始推理',
  planner_turn_started: '生成计划',
  planner_model_stream_started: '模型开始输出',
  planner_model_waiting: '模型仍在处理',
  planner_tool_started: '调用工具',
  planner_tool_completed: '工具返回',
  planner_agent_completed: '计划已生成',
  planner_completed: '规划完成',
  planner_failed: '规划失败',
  planning_proposal_completed: '提案已提交',
  clarification_requested: '需要用户澄清',
  proposal_rejected: '提案被拒绝',
  planner_convergence_exhausted: '提案未收敛',
  proposal_transport_uncertain: '提案传输待确认',
  proposal_conflict: '提案冲突',
  turn_cancelled: '本轮已取消',
};

export interface PlanningToolCall {
  readonly sequence: number;
  readonly name: string;
  readonly status: 'completed' | 'failed' | 'running';
  readonly argumentFields: readonly string[];
  readonly resultFields: readonly string[];
}

export interface PlanningDetailFacts {
  readonly events: readonly InteractionTraceEvent[];
  readonly toolCalls: readonly PlanningToolCall[];
  readonly outcome: string | null;
  readonly elapsedMs: number | null;
}

function isPlanningEvent(event: InteractionTraceEvent): boolean {
  return event.phase === 'planning'
    || event.kind.startsWith(PLANNING_KIND_PREFIX)
    || event.kind === 'planning_proposal_completed'
    || event.kind === 'clarification_requested'
    || event.kind.startsWith('proposal_')
    || event.kind === 'turn_cancelled';
}

function elapsedLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function clockLabel(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '--:--:--';
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
}

/** Pure projection so the drawer can be tested without a live trace stream. */
export function planningDetailFacts(trace: readonly InteractionTraceEvent[]): PlanningDetailFacts {
  const events = [...trace]
    .filter(isPlanningEvent)
    .sort((left, right) => {
      const delta = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
      return Number.isFinite(delta) && delta !== 0 ? delta : left.sequence - right.sequence;
    });
  const started: PlanningToolCall[] = [];
  for (const event of events) {
    if (event.kind === 'planner_tool_started') {
      started.push({
        sequence: started.length + 1,
        name: readString(event.details?.toolName) ?? 'tool',
        status: 'running',
        argumentFields: readFields(event.details?.argumentFields),
        resultFields: [],
      });
    } else if (event.kind === 'planner_tool_completed') {
      const current = [...started].reverse().find(call => call.status === 'running');
      if (current) {
        started[started.indexOf(current)] = {
          ...current,
          status: readString(event.details?.status) === 'failed' ? 'failed' : 'completed',
          resultFields: readFields(event.details?.resultFields),
        };
      }
    }
  }
  const first = events[0];
  const last = events.at(-1);
  const elapsedMs = first && last
    ? Math.max(0, Date.parse(last.occurredAt) - Date.parse(first.occurredAt))
    : null;
  const terminal = [...events].reverse().find(event => [
    'planning_proposal_completed',
    'clarification_requested',
    'proposal_rejected',
    'planner_convergence_exhausted',
    'proposal_transport_uncertain',
    'proposal_conflict',
    'planner_failed',
    'turn_cancelled',
  ].includes(event.kind));
  const outcome = terminal
    ? KIND_LABELS[terminal.kind] ?? terminal.kind
    : events.length > 0 ? '进行中' : null;
  return { events, toolCalls: started, outcome, elapsedMs };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 24);
}

function stepLabel(event: InteractionTraceEvent): string {
  const base = KIND_LABELS[event.kind] ?? event.kind;
  const toolName = readString(event.details?.toolName);
  if (event.kind === 'planner_tool_started' || event.kind === 'planner_tool_completed') {
    return toolName ? `${base} · ${toolName}` : base;
  }
  return base;
}

export function PlanningDetailDrawer({
  conversationId,
  turnId,
  http,
  events,
  onClose,
}: {
  conversationId: string;
  turnId: string;
  http: HttpClient;
  /** Pre-loaded trace (live Turn). Omit to read the settled Turn from the server. */
  events?: readonly InteractionTraceEvent[];
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<readonly InteractionTraceEvent[] | null>(events ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (events) { setLoaded(events); return; }
    let active = true;
    setError(null);
    void http.getConversationTrace(conversationId, turnId)
      .then(page => { if (active) setLoaded(page.events); })
      .catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, [conversationId, turnId, http, events]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const facts = useMemo(() => planningDetailFacts(loaded ?? []), [loaded]);
  return <div className="planning-detail-overlay" role="presentation" onClick={onClose}>
    <aside className="execution-detail-drawer planning-detail-drawer" data-testid="planning-detail-drawer"
      aria-label="规划详情" onClick={event => event.stopPropagation()}>
      <header className="execution-detail-header">
        <div className="execution-detail-title">
          <span>PLANNING DETAIL</span>
          <strong>Manager 规划过程</strong>
          <small>
            {facts.outcome ?? '未开始'}
            {facts.toolCalls.length > 0 ? ` · 工具调用 ${facts.toolCalls.length} 次` : ''}
            {facts.elapsedMs !== null ? ` · ${elapsedLabel(facts.elapsedMs)}` : ''}
          </small>
        </div>
        <button type="button" className="execution-detail-close" onClick={onClose}
          aria-label="关闭规划详情" title="关闭（Esc）">✕</button>
      </header>
      <div className="execution-detail-body">
        {error && <div className="execution-detail-empty"><strong>规划记录不可用</strong><p>{error}</p></div>}
        {!error && loaded === null && <div className="execution-detail-empty">正在读取规划记录…</div>}
        {!error && loaded !== null && facts.events.length === 0 && (
          <div className="execution-detail-empty">
            <strong>该轮未记录规划细节</strong>
            <p>规划遥测在本次升级之后才开始记录；旧轮次只保留最终提案与执行记录。</p>
          </div>
        )}
        {facts.events.length > 0 && (
          <>
            <ol className="planning-detail-steps">
              {facts.events.map(event => (
                <li key={`${event.sequence}-${event.kind}`} className="planning-detail-step"
                  data-kind={event.kind}>
                  <div className="planning-detail-step-head">
                    <span>{clockLabel(event.occurredAt)}</span>
                    <strong>{stepLabel(event)}</strong>
                  </div>
                  {readString(event.summary) && <p>{event.summary}</p>}
                  {event.kind === 'planner_tool_started' && readFields(event.details?.argumentFields).length > 0 && (
                    <small>参数：{readFields(event.details?.argumentFields).join(', ')}</small>
                  )}
                  {event.kind === 'planner_tool_completed' && readFields(event.details?.resultFields).length > 0 && (
                    <small>结果字段：{readFields(event.details?.resultFields).join(', ')}</small>
                  )}
                </li>
              ))}
            </ol>
            {facts.toolCalls.length > 0 && (
              <section className="planning-detail-tools">
                <h4>工具调用</h4>
                <ul>
                  {facts.toolCalls.map(call => (
                    <li key={call.sequence} data-status={call.status}>
                      <strong>{call.name}</strong>
                      <span>{call.status === 'failed' ? '失败' : call.status === 'running' ? '进行中' : '完成'}</span>
                      {call.argumentFields.length > 0 && <small>参数：{call.argumentFields.join(', ')}</small>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  </div>;
}
