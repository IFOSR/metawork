import { useEffect, useState } from 'react';
import type { ExecutionTimeline, StageStatus, TimelineStage } from '../api/types';

interface TraceStep {
  key: string;
  label: string;
  status: StageStatus;
}

const COLLAPSED_TASK_STATUSES = new Set(['done', 'cancelled', 'archived']);

/**
 * 对话内嵌的执行轨迹：只展示可验证的 durable 执行事实（不是模型的 chain-of-thought）。
 * 默认紧凑一行；任务进行中自动展开，完成后自动折叠，用户点击可随时覆盖。
 */
export function ExecutionTrace({ timeline }: { timeline: ExecutionTimeline | null }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const taskId = timeline?.taskId ?? null;

  // 新任务出现时回到自动模式（运行展开 / 完成折叠）。
  useEffect(() => {
    setOverride(null);
  }, [taskId]);

  if (!timeline) return null;
  const steps = deriveTraceSteps(timeline);
  const active = !COLLAPSED_TASK_STATUSES.has(timeline.status);
  const expanded = override ?? active;

  const current =
    [...steps].reverse().find(step => step.status === 'running')
    ?? [...steps].reverse().find(step => step.status === 'failed' || step.status === 'blocked')
    ?? [...steps].reverse().find(step => step.status === 'done');
  const summary = current
    ? current.label
    : `${steps.filter(step => step.status === 'done').length}/${steps.length} 步完成`;

  return (
    <div className="trace-card" data-active={active}>
      <button
        type="button"
        className="trace-summary"
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
      >
        <span className="trace-title">执行轨迹</span>
        <span className="trace-current">{summary}</span>
        <span className="trace-toggle">{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded && (
        <ol className="trace-steps">
          {steps.map(step => (
            <li key={step.key} className="trace-step" data-status={step.status}>
              {step.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function deriveTraceSteps(timeline: ExecutionTimeline): TraceStep[] {
  const steps: TraceStep[] = [{ key: 'understand', label: '理解请求', status: 'done' }];
  const stages = new Map(timeline.stages.map(stage => [stage.phase, stage]));
  const planning = stages.get('planning');
  const authorization = stages.get('authorization');
  const execution = stages.get('execution');
  const verification = stages.get('verification');
  const delivery = stages.get('delivery');

  steps.push(planningStep(planning));
  steps.push(authorizationStep(authorization, planning));

  for (const subtask of execution?.subtasks ?? []) {
    steps.push({
      key: `exec-${subtask.id}`,
      label: `分配给 ${subtask.executor ?? 'Executor'} · ${subtask.title}`,
      status: mapSubtaskStatus(subtask.status),
    });
  }

  if (verification && verification.status !== 'pending') {
    steps.push({
      key: 'verify',
      label: verification.status === 'done'
        ? '验证通过'
        : verification.status === 'failed'
          ? '验证未通过'
          : verification.status === 'blocked'
            ? '验证受阻'
            : '验证中',
      status: verification.status,
    });
  }

  if (delivery && delivery.status !== 'pending') {
    steps.push({
      key: 'deliver',
      label: delivery.status === 'done'
        ? '交付完成'
        : delivery.status === 'blocked'
          ? '交付受阻'
          : delivery.status === 'failed'
            ? '交付失败'
            : '正在汇总最终答案',
      status: delivery.status,
    });
  }

  return steps;
}

function planningStep(planning: TimelineStage | undefined): TraceStep {
  if (planning?.status === 'done' && planning.proposal) {
    return {
      key: 'plan',
      label: `Planner 生成 ${planning.proposal.subtasks.length} 个子任务`,
      status: 'done',
    };
  }
  if (planning?.status === 'failed' || planning?.status === 'blocked') {
    return { key: 'plan', label: '规划受阻', status: planning.status };
  }
  return { key: 'plan', label: '规划中', status: 'running' };
}

function authorizationStep(
  authorization: TimelineStage | undefined,
  planning: TimelineStage | undefined,
): TraceStep {
  if (authorization?.status === 'done') {
    return {
      key: 'auth',
      label: `Kernel 完成 ${authorization.decisions?.length ?? 0} 项授权决策`,
      status: 'done',
    };
  }
  if (authorization?.status === 'failed' || authorization?.status === 'blocked') {
    return { key: 'auth', label: 'Kernel 授权受阻', status: authorization.status };
  }
  if (planning?.status === 'done') {
    return { key: 'auth', label: 'Kernel 授权中', status: 'running' };
  }
  return { key: 'auth', label: 'Kernel 授权', status: 'pending' };
}

function mapSubtaskStatus(status: string): StageStatus {
  switch (status) {
    case 'done':
      return 'done';
    case 'running':
    case 'awaiting_integration':
    case 'awaiting_decision':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}
