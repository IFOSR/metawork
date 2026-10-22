import { useEffect, useId, useRef, useState } from 'react';
import type { WsClient } from '../api/ws';
import { useCommandCompletion } from './use-command-completion';
import { applyCommandSuggestion } from '../command-completion';
import type { GatewayCommandSuggestion } from '../../../src/gateway/task-view';
import type { AttachmentMetadata } from '../api/session-types';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../attachment-limits';

const MAX_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;

export interface PendingAttachment {
  metadata: AttachmentMetadata;
}

export function Composer({
  draft,
  commandClient,
  conversationId,
  disabled,
  running,
  blockedReason,
  attachments,
  uploadError,
  uploading = [],
  onDraftChange,
  onSend,
  onCancel,
  onFilesSelected,
  onRemoveAttachment,
  onOpenAttachment,
}: {
  draft: string;
  commandClient?: WsClient;
  conversationId?: string | null;
  disabled: boolean;
  running: boolean;
  blockedReason?: string | null;
  attachments: PendingAttachment[];
  uploadError?: string | null;
  uploading?: Array<{ name: string; size: number }>;
  onDraftChange: (value: string) => void;
  onSend: (value: string, attachments: Array<{ attachmentId: string }>) => void;
  /** Stops the current Planner/Executor turn instead of queueing a command. */
  onCancel: () => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onOpenAttachment?: (conversationId: string, attachment: AttachmentMetadata) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [cursor, setCursor] = useState(draft.length);
  const [selected, setSelected] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const listId = useId();
  const completion = useCommandCompletion(commandClient, conversationId, draft, cursor, focused && !disabled && !composing);
  useEffect(() => setSelected(0), [completion.suggestions]);
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, selected]);
  const acceptSuggestion = (suggestion: GatewayCommandSuggestion) => {
    const next = applyCommandSuggestion(draft, suggestion);
    if (!next) return;
    onDraftChange(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // IME composition 状态：合成期间 Enter 属于输入法（确认候选词），不发送。
  const composingRef = useRef(false);
  const justEndedCompositionRef = useRef(false);

  const submit = () => {
    const value = draft.trim();
    if (!value || disabled) return;
    onSend(value, attachments.map(entry => ({ attachmentId: entry.metadata.attachmentId })));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
    if (completion.open && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'Escape') {
        event.preventDefault(); completion.dismiss(); return;
      }
      if (completion.loading && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); return;
      }
      if (completion.suggestions.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + completion.suggestions.length) % completion.suggestions.length);
          return;
        }
        if (!event.shiftKey && (event.key === 'Tab' || event.key === 'Enter')) {
          event.preventDefault();
          acceptSuggestion(completion.suggestions[selected] ?? completion.suggestions[0]!);
          return;
        }
      }
    }
    if (event.key !== 'Enter') return;
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
      onPaste={event => {
        if (disabled) return;
        const files = Array.from(event.clipboardData.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        onFilesSelected(files);
      }}
    >
      {completion.open && (
        <div className="command-completion">
          <div className="command-completion-heading">指令联想 <span>↑↓ 选择 · Tab / Enter 补入 · Esc 收起</span></div>
          <div id={listId} role="listbox" aria-label="指令联想" className="command-completion-list">
            {completion.suggestions.map((suggestion, index) => (
              <div key={`${suggestion.value}:${index}`} id={`${listId}-${index}`} role="option"
                aria-selected={index === selected} className="command-completion-option"
                onMouseDown={event => event.preventDefault()}
                onClick={() => acceptSuggestion(suggestion)}>
                <code>{suggestion.label}</code><span>{suggestion.description}</span>
              </div>
            ))}
          </div>
          {completion.hint && <div className="command-completion-hint" role="status">{completion.hint}</div>}
        </div>
      )}
      {blockedReason && <div className="composer-notice">{blockedReason}</div>}
      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault();
          if (!composingRef.current) submit();
        }}
      >
        <textarea
          ref={textareaRef}
          aria-label="会话消息"
          aria-autocomplete="list"
          aria-expanded={completion.open}
          aria-controls={completion.open ? listId : undefined}
          aria-activedescendant={completion.open && completion.suggestions.length > 0 ? `${listId}-${selected}` : undefined}
          onFocus={() => { setFocused(true); completion.reopen(); }}
          onBlur={() => setFocused(false)}
          onSelect={event => setCursor(event.currentTarget.selectionStart)}
          value={draft}
          disabled={disabled}
          onChange={event => {
            setCursor(event.target.selectionStart);
            onDraftChange(event.target.value);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
            justEndedCompositionRef.current = false;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
            // Safari 在 compositionend 之后才派发同一次 keydown(Enter)。
            justEndedCompositionRef.current = true;
            window.setTimeout(() => {
              justEndedCompositionRef.current = false;
            }, 0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? '连接就绪并选择会话后即可输入' : '描述目标，或输入 / 查看指令…（可拖入、粘贴或点击 📎 添加附件）'}
          rows={2}
        />
        {(attachments.length > 0 || uploading.length > 0 || uploadError) && (
          <div className="attachment-strip">
            {attachments.map(entry => (
              <span className="attachment-chip" key={entry.metadata.attachmentId} title={`${entry.metadata.name} · ${entry.metadata.mime}`}>
                <button type="button" className="attachment-preview-button" title={`预览 ${entry.metadata.name}`}
                  onClick={() => onOpenAttachment?.(entry.metadata.conversationId, entry.metadata)}>
                  {entry.metadata.mediaClass === 'image' ? '🖼' : entry.metadata.mediaClass === 'document' ? '▤' : '📄'} {entry.metadata.name}
                </button>
                <button
                  type="button"
                  aria-label={`移除附件 ${entry.metadata.name}`}
                  onClick={() => onRemoveAttachment(entry.metadata.attachmentId)}
                >
                  ✕
                </button>
              </span>
            ))}
            {uploading.map(file => (
              <span className="attachment-chip attachment-chip-uploading" key={`uploading:${file.name}:${file.size}`}>
                ⟳ {file.name} · 上传中
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
              title="添加附件"
            >
              📎
            </button>
            {running && (
              <button
                type="button"
                className="stop-button"
                disabled={disabled}
                title="停止当前轮：终止运行中的 Planner 与执行器，不会创建新任务"
                onClick={() => {
                  if (window.confirm('确定停止当前轮？运行中的 Planner 与执行器会被终止。')) {
                    onCancel();
                  }
                }}
              >
                ⏹ 停止
              </button>
            )}
            <button type="submit" disabled={disabled || !draft.trim()}>
              发送
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
