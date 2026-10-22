import { useEffect, useState } from 'react';
import type { WsClient } from '../api/ws';
import type { GatewayCommandCompletionPayload, GatewayCommandSuggestion } from '../../../src/gateway/task-view';

const EMPTY_SUGGESTIONS: GatewayCommandSuggestion[] = [];

export function useCommandCompletion(client: WsClient | undefined, conversationId: string | null | undefined,
  text: string, cursor: number, enabled: boolean) {
  const key = JSON.stringify([conversationId, text, cursor]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; payload?: GatewayCommandCompletionPayload; failed?: boolean } | null>(null);
  const active = Boolean(client && conversationId && enabled && text.startsWith('/') && !text.includes('\n')
    && new TextEncoder().encode(text).length <= 8 * 1024 && dismissed !== key);

  useEffect(() => {
    setResult(null);
    if (!active || !client || !conversationId) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      void client.query<GatewayCommandCompletionPayload>(conversationId, { kind: 'complete_command', text, cursor })
        .then(payload => {
          if (!stale) setResult(payload.targetConversationId === conversationId ? { key, payload } : { key, failed: true });
        })
        .catch(() => { if (!stale) setResult({ key, failed: true }); });
    }, 180);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [active, client, conversationId, text, cursor, key]);

  const current = active && result?.key === key ? result : null;
  const payload = current?.payload;
  return {
    open: active && payload?.state !== 'inactive',
    loading: active && !current,
    suggestions: payload?.suggestions ?? EMPTY_SUGGESTIONS,
    hint: current?.failed ? '暂时无法获取联想，可继续编辑或输入 /help。'
      : !current ? '正在查找指令…' : payload?.error ?? payload?.hint,
    dismiss: () => setDismissed(key),
    reopen: () => setDismissed(null),
  };
}
