import { useEffect, useState } from 'react';
import type { MemoryApiClient, MemoryEngineProblem, MemoryStatusView } from '../api/memory';

const ENGINE_PROBLEM_NOTES: Record<MemoryEngineProblem, string> = {
  extraction_model_required: '请选择记忆抽取使用的 Provider 和模型；在此之前不会产生任何记忆请求。',
  extraction_credential_missing: '所选 Provider 缺少可用的 API Key，请先在模型服务中补齐凭据。',
  engine_missing: '记忆引擎没有随当前发布包安装到本机（缺少 memory/tdai），请更新或重新安装 MetaWork。',
  engine_unreachable: '记忆引擎没有运行或无法连接，请检查安装状态后重试。',
  engine_unhealthy: '记忆引擎自检未通过，暂时无法写入或召回记忆。',
  fts5_unavailable: '记忆引擎的 SQLite 缺少 FTS5，BM25 召回会静默失效，因此记忆暂不可用。',
};

/** One actionable sentence for the first problem the user has to fix. */
export function memoryEngineProblemNote(problem: MemoryEngineProblem | undefined): string | null {
  return problem ? ENGINE_PROBLEM_NOTES[problem] : null;
}

export interface MemorySettingsDraft {
  enabled: boolean;
  providerRef: string;
  modelRef: string;
}

export interface MemorySettingsPanelProps {
  api: MemoryApiClient;
  draft: MemorySettingsDraft;
  onChange: (draft: MemorySettingsDraft) => void;
  disabled?: boolean;
  configurationRevision?: string;
}

export function MemorySettingsPanel({ api, draft, onChange, disabled, configurationRevision }: MemorySettingsPanelProps) {
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.status(controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setError(null); }
    }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [api, configurationRevision, revision]);
  const selectable = (status?.selectableProviders ?? []).filter(provider => !provider.unsupportedReason);
  const unsupported = (status?.selectableProviders ?? []).filter(provider => provider.unsupportedReason);
  const provider = selectable.find(item => item.providerRef === draft.providerRef);
  const models = (provider?.models ?? []).filter(model => model.supportsStructuredOutput && model.enabled);
  const engineNote = memoryEngineProblemNote(status?.engineProblem);
  const mode = status?.mode;
  const modeLabel = mode === 'enabled' ? '长期记忆已开启' : mode === 'disabled' ? '记忆已关闭'
    : mode === 'needs-model' ? '需要设置抽取模型' : mode === 'degraded' ? '记忆暂不可用' : '正在读取状态';
  const pending = status && (draft.enabled !== (status.mode !== 'disabled')
    || (draft.enabled && (draft.providerRef !== (status.providerRef ?? '') || draft.modelRef !== (status.modelRef ?? ''))));
  return <section className="settings-section memory-panel" aria-labelledby="memory-settings-heading">
    <header className="memory-heading"><div><h3 id="memory-settings-heading">记忆服务</h3>
      <p>配置记忆整理与召回；已保存的内容请在工作台“记忆”页查看。</p></div>
      <span className="memory-runtime-status" data-mode={mode}>{modeLabel}</span></header>
    {error && <p className="memory-error" role="alert">{error}<button type="button" className="ghost-button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {engineNote && <p className="memory-note memory-note-warning">{engineNote}</p>}
      <div id="memory-configuration" className="memory-configuration">
        <label className="memory-switch"><input type="checkbox" checked={draft.enabled} disabled={disabled}
          onChange={event => onChange({ ...draft, enabled: event.target.checked })} />启用长期记忆</label>
        {pending && <span className="memory-pending">待保存</span>}
        <p className="memory-note">修改后通过页面底部“保存并激活”生效。关闭后停止后续记忆整理与召回。</p>
        {draft.enabled && <div className="memory-model-picker">
          <label>抽取模型服务<select value={draft.providerRef} disabled={disabled}
            onChange={event => onChange({ ...draft, providerRef: event.target.value, modelRef: '' })}>
            <option value="">请选择模型服务</option>
            {selectable.map(item => <option key={item.providerRef} value={item.providerRef}>{item.displayName}</option>)}
          </select></label>
          <label>抽取模型<select value={draft.modelRef} disabled={disabled || !draft.providerRef}
            onChange={event => onChange({ ...draft, modelRef: event.target.value })}>
            <option value="">请选择模型</option>
            {models.map(model => <option key={model.modelRef} value={model.modelRef}>{model.modelId}</option>)}
          </select></label>
          <p className="memory-note">记忆整理的 Token 用量计入所选模型服务。
          </p>
          {provider && models.length === 0 && <p className="memory-note memory-note-warning">此模型服务下没有可用的抽取模型，请先添加支持结构化输出的模型。</p>}
          {unsupported.length > 0 && <details><summary>查看不支持的模型服务</summary><ul>
            {unsupported.map(item => <li key={item.providerRef}>{item.displayName}：{item.unsupportedReason === 'provider_disabled'
              ? '尚未启用' : '当前记忆引擎暂不支持此连接协议'}</li>)}
          </ul></details>}
        </div>}
      </div>
  </section>;
}
