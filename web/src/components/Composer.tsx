import { useRef, useState } from 'react';
import type { AttachmentMetadata } from '../api/session-types';

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

  const submit = () => {
    const value = draft.trim();
    if (!value || disabled || running) return;
    onSend(value, attachments.map(entry => ({ attachmentId: entry.metadata.attachmentId })));
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
            <button type="submit" disabled={disabled || running || !draft.trim()}>
              {running ? '执行中' : '发送'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
