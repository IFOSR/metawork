import { useRef, useState } from 'react';
import type { AttachmentMetadata } from '../api/session-types';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const MAX_ATTACHMENTS = 32;

export interface PendingAttachment {
  metadata: AttachmentMetadata;
}

export function Composer({
  draft,
  disabled,
  running,
  blockedReason,
  attachments,
  uploadError,
  onDraftChange,
  onSend,
  onFilesSelected,
  onRemoveAttachment,
}: {
  draft: string;
  disabled: boolean;
  running: boolean;
  blockedReason?: string | null;
  attachments: PendingAttachment[];
  uploadError?: string | null;
  onDraftChange: (value: string) => void;
  onSend: (value: string, attachments: Array<{ attachmentId: string }>) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // IME composition 状态：合成期间 Enter 属于输入法（确认候选词），不发送。
  const composingRef = useRef(false);
  const justEndedCompositionRef = useRef(false);

  const submit = () => {
    const value = draft.trim();
    if (!value || disabled || running) return;
    onSend(value, attachments.map(entry => ({ attachmentId: entry.metadata.attachmentId })));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const nativeEvent = event.nativeEvent;
    // 三重判断：isComposing、keyCode 229（部分浏览器在合成期间保持）与
    // 内部 composition ref。composition 刚结束的那一次 Enter 不触发发送，
    // 下一次普通 Enter 才恢复发送语义。
    if (
      nativeEvent.isComposing
      || nativeEvent.keyCode === 229
      || composingRef.current
      || justEndedCompositionRef.current
    ) {
      return;
    }
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      // Shift+Enter 插入换行，交给浏览器默认行为。
      return;
    }
    // 普通 Enter 发送；Ctrl+Enter / Cmd+Enter 显式强制发送。
    event.preventDefault();
    submit();
  };

  return (
    <div
      className="composer-wrap"
      data-dragging={dragging || undefined}
      onDragOver={event => {
        if (disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        if (disabled) return;
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFilesSelected(files);
      }}
    >
      {blockedReason && <div className="composer-notice">{blockedReason}</div>}
      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault();
          if (!composingRef.current) submit();
        }}
      >
        <textarea
          value={draft}
          disabled={disabled}
          onChange={event => onDraftChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
            justEndedCompositionRef.current = false;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            // Safari 在 compositionend 之后才派发同一次 keydown(Enter)。
            justEndedCompositionRef.current = true;
            window.setTimeout(() => {
              justEndedCompositionRef.current = false;
            }, 0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? '激活此历史会话后才能继续' : '描述目标，MetaWork 会展示完整执行过程…（可拖入或点击 📎 添加图片/文本附件）'}
          rows={2}
        />
        {(attachments.length > 0 || uploadError) && (
          <div className="attachment-strip">
            {attachments.map(entry => (
              <span className="attachment-chip" key={entry.metadata.attachmentId} title={`${entry.metadata.name} · ${entry.metadata.mime}`}>
                {entry.metadata.kind === 'image' ? '🖼' : '📄'} {entry.metadata.name}
                <button
                  type="button"
                  aria-label={`移除附件 ${entry.metadata.name}`}
                  onClick={() => onRemoveAttachment(entry.metadata.attachmentId)}
                >
                  ✕
                </button>
              </span>
            ))}
            {uploadError && <span className="attachment-error">{uploadError}</span>}
          </div>
        )}
        <div className="composer-footer">
          <span>Planner → Kernel → Executor</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.json,.ts,.tsx,.js,.mjs,.jsx,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.yml,.yaml,.html,.css,.sql"
            hidden
            onChange={event => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) onFilesSelected(files);
              event.target.value = '';
            }}
          />
          <kbd className="composer-key-hint" aria-label="键盘提示">Enter 发送 · Shift+Enter 换行 · Ctrl/Cmd+Enter 强制发送</kbd>
          <div className="composer-actions">
            <button
              type="button"
              className="attach-button"
              disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
              title="添加图片或文本附件"
            >
              📎
            </button>
            {running && (
              <button
                type="button"
                className="stop-button"
                disabled={disabled}
                title="立即取消当前任务（含终止运行中的执行器，并释放会话队列）"
                onClick={() => {
                  if (window.confirm('确定取消当前任务？运行中的执行器会被终止。')) {
                    onSend('/task clear all', []);
                  }
                }}
              >
                ⏹ 停止
              </button>
            )}
            <button type="submit" disabled={disabled || running || !draft.trim()}>
              {running ? '执行中' : '发送'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
