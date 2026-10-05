import { useEffect, useState } from 'react';

export interface AiActionFeedback {
  status: 'loading' | 'updated' | 'unchanged' | 'error' | 'stale';
  startedAt: number;
  completedAt?: number;
  message?: string;
}

export interface ResponsibilityRewriteFeedback extends AiActionFeedback {
  before: string;
  after?: string;
}

export function AiActionStatus({ feedback, title, detail }: {
  feedback: AiActionFeedback;
  title: string;
  detail: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (feedback.status !== 'loading') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [feedback.status, feedback.startedAt]);
  const elapsed = Math.max(0, Math.floor((now - feedback.startedAt) / 1_000));
  return (
    <div className={`ai-action-status ai-action-status-${feedback.status}`}>
      <span className="ai-action-status-icon" aria-hidden="true">
        {feedback.status === 'loading' ? '◌' : feedback.status === 'error' ? '!' : feedback.status === 'stale' ? 'i' : '✓'}
      </span>
      <div role={feedback.status === 'error' ? 'alert' : 'status'} aria-live="polite">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <span className="ai-action-time" aria-hidden={feedback.status === 'loading' ? true : undefined}>
        {feedback.status === 'loading'
          ? `已等待 ${elapsed} 秒`
          : feedback.completedAt && <time dateTime={new Date(feedback.completedAt).toISOString()}>
            {new Date(feedback.completedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </time>}
      </span>
    </div>
  );
}

export function sameAiText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/gu, ' ') === right.trim().replace(/\s+/gu, ' ');
}

export function aiActionError(error: unknown): string {
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return '等待 AI 响应超时，请重试。';
  const message = error instanceof Error ? error.message : '请求失败，请重试。';
  const body = /^HTTP \d+:\s*(.*)$/su.exec(message)?.[1];
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') return parsed.error;
    } catch { /* Non-JSON proxy errors receive a short controlled message. */ }
    return 'AI 服务暂时不可用，请稍后重试。';
  }
  if (/failed to fetch|networkerror|load failed/iu.test(message)) return '网络连接异常，请检查连接后重试。';
  return message;
}
