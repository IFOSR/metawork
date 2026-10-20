import type { ConversationTurnProjection } from '../api/session-types';

export interface TurnFailureFacts {
  code?: string;
  summary?: string;
  label?: string;
  step?: string;
  provider?: string;
  stage?: string;
  retryable?: boolean;
  attemptStarted?: boolean;
  externalSideEffect?: boolean | 'unknown';
  userAction?: string;
}

export function ExecutionNotice({ turn, failure, receipts }: {
  turn: ConversationTurnProjection;
  failure: TurnFailureFacts | null;
  receipts: string[];
}) {
  const needsAction = turn.status === 'blocked' || turn.status === 'failed';
  const configurationMismatch = needsAction && /Executor configuration (?:(?:content|manifest binding) )?mismatch/u
    .test([failure?.summary, ...receipts].join('\n'));
  const subtasks = turn.executionTimeline?.stages.find(stage => stage.phase === 'execution')?.subtasks ?? [];
  const dependencies = turn.executionTimeline?.stages.find(stage => stage.phase === 'planning')?.proposal?.dependencies ?? [];
  const stageLabels: Record<string, string> = {
    attempt: 'Executor 调用', workspace_preflight: 'Workspace 预检',
    dispatch: '任务派发', completion: '结果校验',
  };
  const title = configurationMismatch ? '执行配置校验未通过，任务需要处理'
    : needsAction ? failure?.label ?? '任务尚未完成，需要处理'
      : '执行过程记录';
  return (
    <section className="execution-notice" data-tone={needsAction ? 'attention' : 'neutral'} aria-label={title}>
      <header className="execution-notice-heading">
        <span className="execution-notice-icon" aria-hidden="true">{needsAction ? '!' : 'i'}</span>
        <div><span className="execution-notice-eyebrow">{needsAction ? '需要处理' : '运行记录'}</span><h3>{title}</h3></div>
      </header>
      {configurationMismatch ? <p className="execution-notice-explanation">
        执行器读取到的模型配置与任务授权的配置不一致，系统已停止本次执行。依赖这些结果的后续工作也无法继续。
      </p> : needsAction && <p className="execution-notice-explanation">
        {failure?.label ? '本次执行未完成。请先处理上述原因，再继续未完成部分。'
          : failure?.summary ?? '部分工作未能继续，请查看执行详情确认原因。'}
      </p>}
      {needsAction && subtasks.length > 0 && <div className="execution-notice-impact">
        <h4>子任务进度 <span>{subtasks.filter(task => task.status === 'done').length} / {subtasks.length} 已完成</span></h4>
        <ul>{subtasks.map(task => {
          const waitingFor = dependencies.filter(([, target]) => target === task.id)
            .map(([source]) => subtasks.find(item => item.id === source))
            .filter(item => item && item.status !== 'done');
          const label = task.status === 'done' ? '已完成' : waitingFor.length ? '等待上游结果'
            : task.status === 'blocked' || task.status === 'failed' ? '需要处理' : '尚未完成';
          return <li key={task.id} data-state={task.status === 'done' ? 'done' : waitingFor.length ? 'waiting' : 'attention'}>
            <span className="execution-notice-task-status">{label}</span><span>{task.title}</span>
          </li>;
        })}</ul>
      </div>}
      {needsAction && <div className="execution-notice-next">
        <h4>下一步</h4>
        <p>{configurationMismatch
          ? '先修复任务所用版本的运行配置，再使用「继续未完成部分」恢复任务。恢复时系统会重新校验配置；反复重试无法跳过这项检查。'
          : failure?.userAction ?? '查看下方错误详情，处理原因后，使用「继续未完成部分」恢复任务。'}</p>
      </div>}
      {(failure || receipts.length > 0) && <details className="execution-notice-details">
        <summary>查看错误与运行详情</summary>
        {failure?.summary && <p className="execution-failure-summary">{failure.summary}</p>}
        {failure && <p className="execution-failure-facts">{[
          failure.code,
          failure.stage ? `阶段：${stageLabels[failure.stage] ?? failure.stage}` : undefined,
          failure.step ? `步骤：${failure.step}` : undefined,
          failure.provider,
          failure.retryable !== undefined ? `恢复：${failure.retryable ? '可自动重试' : '需人工处理'}` : undefined,
          failure.attemptStarted !== undefined ? `Executor：${failure.attemptStarted ? '已启动' : '未启动'}` : undefined,
          failure.externalSideEffect !== undefined ? `副作用：${failure.externalSideEffect === 'unknown' ? '未知' : failure.externalSideEffect ? '可能有' : '无'}` : undefined,
        ].filter(Boolean).join(' · ')}</p>}
        {receipts.length > 0 && <pre>{receipts.join('\n')}</pre>}
      </details>}
    </section>
  );
}
