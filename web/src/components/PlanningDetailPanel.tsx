import { useMemo } from 'react';
import type { InteractionTraceEvent } from '../api/types';

/**
 * 规划过程的展开视图。它属于规划卡片本身：只在 Manager 仍在规划时存在，
 * 用户点开是为了确认“现在走到哪一步”。规划结束后卡片收起，这里也不再保留入口。
 * 只展示阶段、工具名、参数字段名与耗时——不展示 prompt、thinking 或参数值。
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

/** Pure projection so the panel can be tested without a live trace stream. */
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

export function PlanningDetailPanel({ events }: { events: readonly InteractionTraceEvent[] }) {
  const facts = useMemo(() => planningDetailFacts(events), [events]);
  return <section className="planning-detail-panel" data-testid="planning-detail-panel" aria-label="规划过程">
    <header>
      <span>规划过程</span>
      <small>
        {facts.outcome ?? '进行中'}
        {` · ${facts.events.length} 步`}
        {facts.toolCalls.length > 0 ? ` · 工具 ${facts.toolCalls.length} 次` : ''}
        {facts.elapsedMs !== null ? ` · ${elapsedLabel(facts.elapsedMs)}` : ''}
      </small>
    </header>
    <ol>
      {facts.events.map(event => (
        <li key={`${event.sequence}-${event.kind}`} data-kind={event.kind}>
          <time>{clockLabel(event.occurredAt)}</time>
          <div>
            <strong>{stepLabel(event)}</strong>
            {readFields(event.details?.argumentFields).length > 0 && event.kind === 'planner_tool_started' && (
              <small> · 参数 {readFields(event.details?.argumentFields).join(', ')}</small>
            )}
            {readFields(event.details?.resultFields).length > 0 && event.kind === 'planner_tool_completed' && (
              <small> · 返回 {readFields(event.details?.resultFields).join(', ')}</small>
            )}
          </div>
        </li>
      ))}
    </ol>
  </section>;
}
