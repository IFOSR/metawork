import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ExecutionTimeline } from '../api/types';
import { ExecutionTrace } from './ExecutionTrace';

marked.use({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer');
  }
});

interface ChatPaneProps {
  output: string[];
  timeline: ExecutionTimeline | null;
  onSend: (text: string) => void;
}

export function ChatPane({ output, timeline, onSend }: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(output.join('\n'), { async: false })),
    [output],
  );

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <section className="chat-pane">
      <div className="chat-scroll">
        {output.length === 0 && !timeline && (
          <div className="empty-hint">输入你的问题，Agent 会在这里回复。</div>
        )}
        <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        <ExecutionTrace timeline={timeline} />
      </div>
      <form
        className="chat-input"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="输入问题…"
        />
        <button type="submit">发送</button>
      </form>
    </section>
  );
}
