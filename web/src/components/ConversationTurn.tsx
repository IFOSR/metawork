import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import type { ReactNode } from 'react';
import { ArtifactAwareMarkdownContent } from './ArtifactAwareMarkdownContent';
import { GuidanceCard } from './GuidanceCard';
import { TaskQueueCard } from './TaskQueueCard';
import { splitTaskQueueBlock } from '../task-queue';
import { splitGuidanceBlock } from '../guidance-block';
import { parseSystemOutput } from '../system-output';
import { ArtifactLink } from './ArtifactLink';
import { TurnBillCard } from './TurnBillCard';
import { ExecutionNotice, type TurnFailureFacts } from './ExecutionNotice';
import { conversationOutput } from '../conversation-output';

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentIcon(mediaClass: string): string {
  if (mediaClass === 'image') return '🖼';
  if (mediaClass === 'document') return '▤';
  if (mediaClass === 'archive') return '🗜';
  return '📄';
}

function executionStatusLabel(status: ConversationTurnProjection['status']): string {
  if (status === 'running') return '执行中';
  if (status === 'blocked') return '需要处理';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return '已完成';
}

function deliveryPending(turn: ConversationTurnProjection): boolean {
  return turn.deliveryStatus === 'streaming'
    || turn.deliveryStatus === 'verifying'
    || (!turn.deliveryStatus && turn.status === 'completed' && !turn.finalAnswer && Boolean(turn.taskId));
}

function deliveryFailed(turn: ConversationTurnProjection): boolean {
  return turn.deliveryStatus === 'failed';
}

/**
 * Reads the passthrough failure facts the Runtime recorded for this Turn, so a
 * blocked or failed Turn shows what actually went wrong and where.
 */
function turnFailureFacts(turn: ConversationTurnProjection): TurnFailureFacts | null {
  for (const event of [...turn.traceEvents].reverse()) {
    if (event.kind === 'execution_resumed') return null;
    const details = event.details as Record<string, unknown> | undefined;
    if (!details || typeof details.failureSummary !== 'string') continue;
    const summary = details.failureSummary;
    const interruptedStream = /(?:upstream\s+)?response\s+stream\s+(?:was\s+)?interrupted/i.test(summary);
    const storedCode = typeof details.failureCode === 'string' ? details.failureCode : undefined;
    const provider = details.failureProvider as { httpStatus?: unknown; requestId?: unknown } | undefined;
    return {
      ...(storedCode
        ? { code: interruptedStream && storedCode === 'unknown_executor_failure' ? 'upstream_stream_interrupted' : storedCode }
        : interruptedStream ? { code: 'upstream_stream_interrupted' } : {}),
      summary,
      ...(typeof details.failureLabel === 'string'
        ? { label: details.failureLabel }
        : interruptedStream
          ? { label: '上游模型响应流中断，未收到可用结果' }
          : {}),
      ...(typeof details.failureStep === 'string' ? { step: details.failureStep } : {}),
      ...(typeof details.failureStage === 'string' ? { stage: details.failureStage } : interruptedStream ? { stage: 'attempt' } : {}),
      ...(typeof details.failureRetryable === 'boolean' ? { retryable: details.failureRetryable } : interruptedStream ? { retryable: true } : {}),
      ...(typeof details.attemptStarted === 'boolean' ? { attemptStarted: details.attemptStarted } : interruptedStream ? { attemptStarted: true } : {}),
      ...(details.externalSideEffect === true || details.externalSideEffect === false || details.externalSideEffect === 'unknown'
        ? { externalSideEffect: details.externalSideEffect } : interruptedStream ? { externalSideEffect: 'unknown' } : {}),
      ...(typeof details.userAction === 'string'
        ? { userAction: details.userAction }
        : interruptedStream
          ? { userAction: '系统会自动重试一次；若仍失败，请检查网络、Provider 服务状态和模型额度后再恢复任务。' }
          : {}),
      ...(provider?.httpStatus !== undefined ? { provider: `HTTP ${String(provider.httpStatus)}` } : {}),
    };
  }
  // Terminal Task failures are durable facts projected through the execution
  // timeline. They may have no Executor trace failure (for example, a service
  // health check or port bind failed after the code was written), so fall back
  // to the Task reason instead of showing a generic "see details" prompt.
  const timeline = turn.executionTimeline;
  if (timeline && timeline.status === 'failed'
    && timeline.reasonCode !== 'none') {
    const labels: Record<string, string> = {
      service_start_failed: '服务启动失败',
      service_health_timeout: '服务健康检查超时',
      port_in_use: '服务端口被占用',
      command_not_found: '服务启动命令不存在',
      delivery_failed: '文件交付失败',
      execution_failed: '任务执行失败',
      external_outcome_unknown: '外部操作结果需要核实',
    };
    return {
      code: timeline.reasonCode,
      summary: timeline.reasonMessage || timeline.explanation,
      label: labels[timeline.reasonCode] ?? '任务未完成',
      stage: timeline.reasonCode.startsWith('service_') || timeline.reasonCode === 'port_in_use'
        || timeline.reasonCode === 'command_not_found' ? 'starting_service' : undefined,
    };
  }
  return null;
}

export function ConversationTurnView({
  turn,
  liveExecutionPanel,
  blockedActions,
  onOpenArtifact,
  onOpenAttachment,
  onOpenTrajectory,
  onOpenBilling,
  onRetryDelivery,
}: {
  turn: ConversationTurnProjection;
  liveExecutionPanel?: ReactNode;
  /** Inline controls for a blocked Task. Kept beside the explanation so the
   * next-step copy always points at a visible, actionable control. */
  blockedActions?: ReactNode;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenAttachment?: (conversationId: string, attachment: import('../api/session-types').ConversationAttachment) => void;
  onOpenTrajectory?: (turnId: string) => void;
  onOpenBilling?: (turnId: string) => void;
  onRetryDelivery?: (turnId: string) => void;
}) {
  // 历史会话记录可能没有 artifacts 字段；防御性兜底避免整树卸载。
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  const isSystemCommand = turn.interactionKind === 'system_command'
    || turn.userInput.trim().startsWith('/');
  const hasTaskExecution = Boolean(
    turn.taskId
      || turn.executionTimeline
      || turn.traceEvents.some(event => event.taskId || event.phase === 'execution'),
  );
  const stepCount = turn.traceEvents.length;
  const failure = turn.status === 'completed' ? null : turnFailureFacts(turn);
  const resultPending = turn.status === 'completed' && deliveryPending(turn);
  const resultFailed = deliveryFailed(turn);
  const resumedExecution = turn.status === 'running'
    && turn.traceEvents.some(event => event.kind === 'execution_resumed');
  const automaticRetryScheduled = turn.status === 'blocked'
    && turn.traceEvents.some(event => event.kind === 'execution_waiting_retry');
  const attachments = Array.isArray(turn.attachments) ? turn.attachments : [];
  const output = conversationOutput(isSystemCommand ? '' : turn.finalAnswer ?? '');
  const showNotice = Boolean(failure || output.receipts.length > 0);
  return (
    <article className="conversation-turn" data-turn-id={turn.id}>
      <section className="user-message">
        <span>YOU</span>
        <p>{turn.userInput}</p>
        {attachments.length > 0 && (
          <div className="message-attachments" aria-label={`附件 ${attachments.length} 个`}>
            {attachments.map(attachment => {
              const previewable = attachment.mediaClass === 'image' && attachment.status === 'available';
              const previewUrl = attachment.status === 'available'
                ? `/api/attachments/${encodeURIComponent(attachment.attachmentId)}?sessionId=${encodeURIComponent(turn.sessionId)}`
                : undefined;
              return (
                <a
                  className={`message-attachment-card${attachment.status === 'unavailable' ? ' is-unavailable' : ''}`}
                  href={previewUrl}
                  target={previewUrl ? '_blank' : undefined}
                  rel={previewUrl ? 'noreferrer' : undefined}
                  aria-label={`${attachment.name}，${formatAttachmentSize(attachment.size)}，${attachment.status === 'available' ? '已上传' : '附件不可用'}`}
                  key={attachment.attachmentId}
                  onClick={event => {
                    if (onOpenAttachment && attachment.status === 'available') {
                      event.preventDefault(); onOpenAttachment(turn.sessionId, attachment);
                    } else if (!previewUrl) event.preventDefault();
                  }}
                >
                  {previewable
                    ? <img src={previewUrl} alt={`用户上传的截图 ${attachment.name}`} loading="lazy" />
                    : <span className="message-attachment-icon" aria-hidden="true">{attachmentIcon(attachment.mediaClass)}</span>}
                  <span className="message-attachment-meta">
                    <strong>{attachment.name || (attachment.mediaClass === 'image' ? '截图' : '附件')}</strong>
                    <small>{formatAttachmentSize(attachment.size)} · {attachment.status === 'available' ? '已上传' : '附件不可用'}</small>
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </section>
      {liveExecutionPanel}
      {(!isSystemCommand || hasTaskExecution) && hasTaskExecution && (
        <section className="execution-status-line" data-status={turn.status}>
          <span>{resumedExecution
            ? '已恢复执行'
            : automaticRetryScheduled
            ? '等待自动重试'
            : resultPending
            ? '执行已完成，正在整理结果'
            : resultFailed ? '执行已完成，结果交付失败' : executionStatusLabel(turn.status)}{stepCount > 0 ? ` · ${stepCount} 步` : ''}</span>
          {onOpenTrajectory && (
            <button
              type="button"
              className="trajectory-link"
              onClick={() => onOpenTrajectory(turn.id)}
            >
              查看完整轨迹 →
            </button>
          )}
        </section>
      )}
      {showNotice && (
        <ExecutionNotice turn={turn} failure={failure} receipts={output.receipts} />
      )}
      {blockedActions}
      {isSystemCommand && turn.finalAnswer && (() => {
        // The presentation service emits one ASCII box for Feishu/CLI parity.
        // The Web client renders that box as a card and keeps the prose around
        // it, with long durable ids shortened so wrapped text stays readable.
        const guidance = splitGuidanceBlock(turn.finalAnswer);
        const queue = splitTaskQueueBlock(guidance.remainder);
        const notes = parseSystemOutput(queue.remainder);
        return (
          <section className="system-command-result">
            {guidance.block && <GuidanceCard block={guidance.block} />}
            {queue.block && <TaskQueueCard block={queue.block} />}
            {notes.structured ? (
              notes.notes.length > 0 && (
                <p className="system-command-notes">
                  {notes.notes.map(note => <span key={note}>{note}</span>)}
                </p>
              )
            ) : (
              queue.remainder && (
                <ArtifactAwareMarkdownContent
                  value={queue.remainder}
                  artifacts={artifacts}
                  onOpenArtifact={onOpenArtifact}
                />
              )
            )}
          </section>
        );
      })()}
      {!isSystemCommand && output.body && (
        <section className="final-answer">
          <ArtifactAwareMarkdownContent
            value={output.body}
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
          />
        </section>
      )}
      {!isSystemCommand && resultPending && !turn.finalAnswer && (
        <section className="final-answer result-delivery-pending" aria-live="polite">
          执行已完成，正在整理最终结果…
        </section>
      )}
      {!isSystemCommand && resultFailed && (
        <section className="final-answer result-delivery-failed" aria-live="polite">
          结果交付失败，请重试。
          {onRetryDelivery && (
            <button type="button" onClick={() => onRetryDelivery(turn.id)}>
              重新获取结果
            </button>
          )}
        </section>
      )}
      {/* 账单放在任务结果之后；对话中只保留阶段/模型摘要，详情进入账单 Tab。 */}
      {!isSystemCommand && turn.status !== 'running' && (
        <TurnBillCard
          turn={turn}
          taskTitle={turn.executionTimeline?.title}
          onOpenBilling={onOpenBilling ? () => onOpenBilling(turn.id) : undefined}
        />
      )}
      {onOpenArtifact && artifacts.length > 0 && (
        <section className="turn-artifacts" aria-label="任务产物">
          <header><span>ARTIFACTS</span></header>
          <div className="artifact-link-list">
            {artifacts.map(artifact => (
              <ArtifactLink
                artifact={artifact}
                onOpen={() => onOpenArtifact(artifact)}
                key={artifact.artifactId}
              />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
