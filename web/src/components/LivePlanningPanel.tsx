import { useEffect, useState } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';
import type { InteractionTraceEvent } from '../api/types';

/**
 * 规划阶段的活动卡片。
 *
 * Planner 解析需求期间对话 tab 原本没有任何变化，用户无法判断是"在思考"还是
 * "卡住了"。这里把 InteractionTrace 中已公开的 Planner 里程碑投影成与 Executor
 * 执行卡片同形的卡片：阶段、当前步骤、工具调用与耗时都随事件实时更新。
 */

export interface PlannerActivity {
  startedAt: string;
  updatedAt: string;
  stepLabel: string;
  stepKey: string;
  toolCalls: number;
  lastToolName: string | null;
  state: 'running' | 'ready' | 'failed' | 'cancelled';
}

const PLANNER_PHASE_KINDS = new Set([
  'planner_started',
  'planner_process_started',
  'planner_prompt_accepted',
  'planner_agent_started',
  'planner_turn_started',
  'planner_model_stream_started',
  'planner_model_waiting',
  'planner_tool_started',
  'planner_tool_completed',
  'planner_agent_completed',
  'planner_failed',
  'planner_completed',
  'turn_cancel_requested',
  'turn_cancelled',
]);

function isPlannerEvent(event: InteractionTraceEvent): boolean {
  return PLANNER_PHASE_KINDS.has(event.kind) || event.phase === 'planning';
}

/**
 * 判断"当前最新活动"是否仍属于规划阶段。Executor 开始后再显示规划卡片会与执行
 * 卡片重复，因此只有规划阶段晚于执行阶段时才返回活动。
 */
export function plannerActivity(turn: ConversationTurnProjection): PlannerActivity | null {
  const events = [...turn.traceEvents].sort(
    (left, right) => left.sequence - right.sequence
      || left.occurredAt.localeCompare(right.occurredAt),
  );
  let lastPlanning: InteractionTraceEvent | null = null;
  let lastExecutionAt: string | null = null;
  for (const event of events) {
    if (event.phase === 'execution' || event.kind.startsWith('executor_')) {
      lastExecutionAt = event.occurredAt;
      continue;
    }
    if (isPlannerEvent(event)) lastPlanning = event;
  }
  if (!lastPlanning) return null;
  if (lastExecutionAt && lastExecutionAt > lastPlanning.occurredAt) return null;

  const plannerEvents = events.filter(isPlannerEvent);
  const started = plannerEvents.find(event => event.kind === 'planner_started') ?? plannerEvents[0]!;
  const toolStarts = plannerEvents.filter(event => event.kind === 'planner_tool_started');
  const lastTool = [...plannerEvents].reverse().find(event => (
    event.kind === 'planner_tool_started' || event.kind === 'planner_tool_completed'
  ));
  const lastToolName = lastTool
    ? readToolName(lastTool) ?? null
    : toolStarts.length > 0 ? readToolName(toolStarts.at(-1)!) ?? null : null;

  return {
    startedAt: started.occurredAt,
    updatedAt: lastPlanning.occurredAt,
    stepLabel: stepLabelFor(lastPlanning),
    stepKey: lastPlanning.kind,
    toolCalls: toolStarts.length,
    lastToolName,
    state: plannerState(lastPlanning),
  };
}

function plannerState(event: InteractionTraceEvent): PlannerActivity['state'] {
  if (event.kind === 'turn_cancelled' || event.kind === 'turn_cancel_requested') return 'cancelled';
  if (event.kind === 'planner_failed') return 'failed';
  if (event.kind === 'planner_agent_completed' || event.kind === 'planner_completed') return 'ready';
  return 'running';
}

function stepLabelFor(event: InteractionTraceEvent): string {
  const toolName = readToolName(event);
  switch (event.kind) {
    case 'planner_started':
      return '正在理解请求并生成计划…';
    case 'planner_process_started':
      return '正在启动 Planner 进程…';
    case 'planner_prompt_accepted':
      return 'Planner 已接收请求，正在分析…';
    case 'planner_agent_started':
      return 'Planner 已开始推理…';
    case 'planner_turn_started':
      return 'Planner 正在生成计划…';
    case 'planner_model_stream_started':
      return 'Planner 模型正在输出…';
    case 'planner_model_waiting':
      return 'Planner 模型仍在处理，等待输出…';
    case 'planner_tool_started':
      return toolName ? `调用工具 ${toolName}…` : 'Planner 正在调用工具…';
    case 'planner_tool_completed':
      return toolName ? `工具 ${toolName} 已返回` : 'Planner 工具调用已返回';
    case 'planner_agent_completed':
      return '计划已生成，正在准备执行…';
    case 'planner_completed':
      return '计划已生成。';
    case 'turn_cancel_requested':
      return '正在取消本轮…';
    case 'turn_cancelled':
      return '本轮已取消。';
    case 'planner_failed':
      return 'Planner 执行失败。';
    default:
      return event.summary || event.title;
  }
}

function readToolName(event: InteractionTraceEvent): string | undefined {
  const details = event.details as Record<string, unknown> | undefined;
  const toolName = details?.toolName;
  return typeof toolName === 'string' && toolName ? toolName : undefined;
}

export function LivePlanningPanel({ turn }: { turn: ConversationTurnProjection }) {
  const [, setNowMs] = useState(() => Date.now());
  const activity = plannerActivity(turn);
  const live = activity?.state === 'running' && turn.status === 'running';

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.id, live]);

  if (!activity) return null;

  return (
    <section className="live-execution-panel live-planning-panel" aria-label="规划状态">
      <header>
        <span>PLANNING</span>
        {live && <em data-pulse aria-hidden />}
      </header>
      <div className="live-execution-cards">
        <article className="execution-card" data-status={live ? 'running' : 'settled'}>
          <h4>规划当前请求</h4>
          <dl>
            <dt>阶段</dt><dd>{planningStageLabel(activity.state)}</dd>
            {activity.toolCalls > 0 && (
              <>
                <dt>工具调用</dt>
                <dd>
                  {activity.toolCalls} 次{activity.lastToolName ? ` · 最近 ${activity.lastToolName}` : ''}
                </dd>
              </>
            )}
          </dl>
          <p className="execution-card-step" data-activity={activity.stepKey}>
            {activity.stepLabel}
          </p>
          <footer>
            <time>{formatElapsed(activity.startedAt, live ? Date.now() : Date.parse(activity.updatedAt))}</time>
          </footer>
        </article>
      </div>
    </section>
  );
}

function planningStageLabel(state: PlannerActivity['state']): string {
  if (state === 'ready') return '计划已生成';
  if (state === 'failed') return '规划失败';
  if (state === 'cancelled') return '已取消';
  return '规划中';
}

function formatElapsed(start: string, end: number): string {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return '0s';
  const elapsedMs = Math.max(0, end - startMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}
