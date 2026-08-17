export function Composer({
  draft,
  disabled,
  running,
  blockedReason,
  onDraftChange,
  onSend,
}: {
  draft: string;
  disabled: boolean;
  running: boolean;
  blockedReason?: string | null;
  onDraftChange: (value: string) => void;
  onSend: (value: string) => void;
}) {
  const submit = () => {
    const value = draft.trim();
    if (!value || disabled || running) return;
    onSend(value);
  };
  return (
    <div className="composer-wrap">
      {blockedReason && <div className="composer-notice">{blockedReason}</div>}
      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          disabled={disabled}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? '激活此历史会话后才能继续' : '描述目标，AnyFusion 会展示完整执行过程…'}
          rows={2}
        />
        <div className="composer-footer">
          <span>Planner → Kernel → Executor</span>
          <button type="submit" disabled={disabled || running || !draft.trim()}>
            {running ? '执行中' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}
