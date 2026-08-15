import { useState } from 'react';

interface ChatPaneProps {
  output: string[];
  onSend: (text: string) => void;
}

export function ChatPane({ output, onSend }: ChatPaneProps) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <section className="chat-pane">
      <div className="chat-scroll">
        {output.length === 0 && (
          <div className="empty-hint">输入你的问题，Agent 会在这里回复。</div>
        )}
        {output.map((line, index) => (
          <div className="chat-line" key={index}>{line}</div>
        ))}
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
