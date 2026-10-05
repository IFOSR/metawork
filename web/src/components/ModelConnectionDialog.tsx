import { useEffect, useState } from 'react';

export interface NewModelConnectionDraft {
  displayName: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelConnectionDialogProps {
  open: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: (draft: NewModelConnectionDraft) => void;
}

const EMPTY_DRAFT: NewModelConnectionDraft = {
  displayName: '',
  baseUrl: '',
  apiKey: '',
};

export function ModelConnectionDialog({
  open,
  disabled = false,
  onCancel,
  onConfirm,
}: ModelConnectionDialogProps) {
  const [draft, setDraft] = useState<NewModelConnectionDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(EMPTY_DRAFT);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const update = (field: keyof NewModelConnectionDraft, value: string) => {
    setDraft(current => ({ ...current, [field]: value }));
    setError(null);
  };

  const confirm = () => {
    const next = {
      displayName: draft.displayName.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
    };
    if (!next.displayName || !next.baseUrl) {
      setError('请填写模型名称、API URL 和 API Key（模型名称即 Provider 名称，OpenRouter 可留空 API Key）。');
      return;
    }
    onConfirm(next);
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="model-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-connection-dialog-title"
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          confirm();
        }}
      >
        <div className="model-connection-dialog-heading">
          <div>
            <span className="settings-eyebrow">新增模型</span>
            <h3 id="model-connection-dialog-title">新增模型</h3>
            <p>填写 Provider 连接信息后，MetaWork 会自动获取公开模型、能力和价格。</p>
          </div>
          <button type="button" className="ghost-button" onClick={onCancel}>关闭</button>
        </div>
        <div className="model-connection-dialog-fields">
          <label className="settings-field">
            <span>Provider 名称</span>
            <input
              className="text-input"
              value={draft.displayName}
              placeholder="例如：OpenRouter 或工作用模型服务"
              onChange={event => update('displayName', event.target.value)}
              autoFocus
            />
          </label>
          <label className="settings-field">
            <span>API URL</span>
            <input
              className="text-input"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={event => update('baseUrl', event.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>API Key（OpenRouter 可留空）</span>
            <input
              className="text-input"
              type="password"
              value={draft.apiKey}
              placeholder="输入 API Key（可选）"
              autoComplete="new-password"
              onChange={event => update('apiKey', event.target.value)}
            />
          </label>
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="model-connection-dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>取消</button>
          <button type="button" className="primary-button" disabled={disabled} onClick={confirm}>
            新增模型
          </button>
        </div>
      </form>
    </div>
  );
}
