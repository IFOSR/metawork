import { useState } from 'react';
import type { HttpClient } from '../api/http';
import type {
  ExecutorConfigurationChange, ExecutorEditableFields, ExecutorManagementView,
  ExecutorToolId, PreparedExecutorConfiguration, ConfigSnapshot,
} from '../api/types';

interface Props {
  http: HttpClient;
  view: ExecutorManagementView;
  agentClassRef?: string;
  operation: ExecutorConfigurationChange['operation'];
  disabled: boolean;
  onClose(): void;
  onSaved(snapshot: ConfigSnapshot, agentClassRef: string): void;
}

const labels = { create: '新增', update: '编辑', enable: '启用', disable: '停用', remove: '删除' };

export function ExecutorEditorDialog({ http, view, agentClassRef, operation, disabled, onClose, onSaved }: Props) {
  const existing = view.executors.find(agent => agent.agentClassRef === agentClassRef);
  const [tool, setTool] = useState<ExecutorToolId>(existing?.tool ?? 'pi');
  const [fields, setFields] = useState<ExecutorEditableFields>(() => ({
    displayName: existing?.displayName ?? '',
    modelPolicy: existing?.modelPolicy ?? { mode: 'fixed', modelRef: '' },
    permissionProfileRef: existing?.permissionProfileRef ?? view.permissions[0]?.ref ?? '',
    manualSourceText: existing?.manualSourceText ?? '',
    enabled: existing?.enabled ?? true,
  }));
  const [prepared, setPrepared] = useState<PreparedExecutorConfiguration | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = operation === 'create' || operation === 'update';
  const locked = disabled || saving;
  const models = view.tools.find(entry => entry.id === tool)?.models ?? [];
  const update = (patch: Partial<ExecutorEditableFields>) => {
    setFields(current => ({ ...current, ...patch }));
    setPrepared(null);
    setError('');
  };
  const prepare = async () => {
    setSaving(true);
    setError('');
    try {
      const change: ExecutorConfigurationChange = operation === 'create'
        ? { operation, tool, fields }
        : operation === 'update'
          ? { operation, agentClassRef: agentClassRef!, fields }
          : { operation, agentClassRef: agentClassRef! };
      let next = await http.prepareExecutor(view.baseRevisionId, change);
      const ref = next.createdAgentClassRef ?? agentClassRef!;
      if (editing) {
        const analysis = await http.compileExecutorCapabilityManual(
          ref, next.baseRevisionId, fields.manualSourceText, next.config,
        );
        next = { ...next, config: analysis.config };
        setMarkdown(analysis.manual.markdown);
        setWarning(analysis.warning ?? '');
      }
      setPrepared(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally { setSaving(false); }
  };
  const save = async () => {
    if (!prepared || locked) return;
    setSaving(true);
    setError('');
    try {
      const result = await http.activate(prepared.baseRevisionId, prepared.config);
      if (!result.ok) {
        setError(result.code === 'revision_conflict'
          ? '配置已在其他窗口更新。当前输入已保留，请关闭后刷新配置再重试。'
          : result.issues?.join('；') || '配置未生效，请检查系统是否空闲。');
        return;
      }
      // Use the exact successful candidate; do not misreport a later GET failure as a failed save.
      onSaved({ revisionId: result.revisionId!, runningRevisionId: result.revisionId!, contentHash: '', config: prepared.config },
        prepared.createdAgentClassRef ?? agentClassRef!);
    } catch (failure) {
      setError(`${(failure as Error).message}。结果不确定，请先刷新配置确认，不要重复新增。`);
    } finally { setSaving(false); }
  };
  return (
    <div className="modal-backdrop">
      <form className="model-connection-dialog executor-editor-dialog" role="dialog" aria-modal="true"
        aria-labelledby="executor-editor-title" onSubmit={event => { event.preventDefault(); void prepare(); }}>
        <div className="model-connection-dialog-heading">
          <div><h3 id="executor-editor-title">{labels[operation]}执行助手</h3>
            <p>只保存当前助手，不影响其他未保存的编辑。工具固定为 Pi 或 Codex CLI。</p></div>
          <button type="button" className="ghost-button" disabled={saving} onClick={onClose}>关闭</button>
        </div>
        <div className="executor-editor-body">
        {editing ? <fieldset disabled={locked} className="executor-editor-fields">
          <label className="settings-field"><span>名称</span>
            <input className="text-input" required maxLength={80} value={fields.displayName}
              onChange={event => update({ displayName: event.target.value })} autoFocus /></label>
          <label className="settings-field"><span>执行工具</span>
            <select className="text-input" value={tool} disabled={operation !== 'create'}
              onChange={event => { setTool(event.target.value as ExecutorToolId); update({ modelPolicy: { mode: 'fixed', modelRef: '' } }); }}>
              {view.tools.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.available}>{entry.label}</option>)}
            </select></label>
          <label className="settings-field"><span>模型选择</span>
            <select className="text-input" value={fields.modelPolicy.mode} onChange={event => update({
              modelPolicy: event.target.value === 'auto' ? { mode: 'auto', allowedModelRefs: [] } : { mode: 'fixed', modelRef: '' },
            })}><option value="fixed">固定模型</option><option value="auto">自动选择</option></select></label>
          {fields.modelPolicy.mode === 'fixed'
            ? <label className="settings-field"><span>使用模型</span>
              <select className="text-input" required value={fields.modelPolicy.modelRef}
                onChange={event => update({ modelPolicy: { mode: 'fixed', modelRef: event.target.value } })}>
                <option value="">请选择模型</option>
                {models.map(model => <option key={model.ref} value={model.ref} disabled={!model.fixedAllowed}>{model.label}</option>)}
              </select></label>
            : <div className="settings-field"><span>允许系统选择的模型</span>
              <div className="executor-model-list" role="group" aria-label="允许系统选择的模型">
              {models.map(model => {
                const unsupported = !model.autoAllowed;
                return <label key={model.ref}
                  className={`executor-model-option${unsupported ? ' is-disabled' : ''}`}>
                  <input type="checkbox" disabled={unsupported}
                    checked={fields.modelPolicy.mode === 'auto' && fields.modelPolicy.allowedModelRefs.includes(model.ref)}
                    onChange={event => {
                      if (fields.modelPolicy.mode !== 'auto') return;
                      const refs = event.target.checked ? [...fields.modelPolicy.allowedModelRefs, model.ref]
                        : fields.modelPolicy.allowedModelRefs.filter(ref => ref !== model.ref);
                      update({ modelPolicy: {
                        ...fields.modelPolicy, allowedModelRefs: refs,
                        defaultModelRef: refs.includes(fields.modelPolicy.defaultModelRef ?? '') ? fields.modelPolicy.defaultModelRef : undefined,
                        fallback: fields.modelPolicy.fallback ? {
                          enabled: fields.modelPolicy.fallback.enabled && fields.modelPolicy.fallback.order.some(ref => refs.includes(ref)),
                          order: fields.modelPolicy.fallback.order.filter(ref => refs.includes(ref)),
                        } : undefined,
                      } });
                    }} />
                  <span className="executor-model-option-text">
                    <span className="executor-model-option-label">{model.label}</span>
                    {unsupported && <span className="executor-model-option-note">不支持此工具的自动选择</span>}
                  </span>
                </label>;
              })}
              </div>
              <label className="settings-field executor-priority-field"><span>选择偏好</span>
                <select className="text-input" value={fields.modelPolicy.objective?.priority ?? 'balanced'}
                  onChange={event => {
                    if (fields.modelPolicy.mode !== 'auto') return;
                    update({ modelPolicy: { ...fields.modelPolicy, objective: {
                      ...fields.modelPolicy.objective,
                      priority: event.target.value as 'balanced' | 'cost' | 'quality' | 'latency',
                    } } });
                  }}>
                  <option value="balanced">均衡</option><option value="cost">成本优先</option>
                  <option value="quality">质量优先</option><option value="latency">速度优先</option>
                </select></label>
            </div>}
          <label className="settings-field"><span>允许的操作范围</span>
            <select className="text-input" value={fields.permissionProfileRef}
              onChange={event => update({ permissionProfileRef: event.target.value })}>
              {view.permissions.map(profile => <option key={profile.ref} value={profile.ref}>{profile.label}</option>)}
            </select></label>
          <label className="settings-field"><span>职责说明</span>
            <textarea className="text-input" rows={4} maxLength={8000} value={fields.manualSourceText}
              onChange={event => update({ manualSourceText: event.target.value })} /></label>
          <label className="executor-enable-row">
            <input type="checkbox" checked={fields.enabled} onChange={event => update({ enabled: event.target.checked })} />
            <span>启用此助手</span></label>
        </fieldset> : <p className="executor-confirm-text">确认{labels[operation]}“{existing?.displayName}”？{operation === 'remove' && '历史工作和文件会保留；删除后不能再分配新工作给它。'}</p>}
        {disabled && <p role="status" className="executor-dialog-notice">系统当前不空闲，暂时不能修改配置。输入已保留。</p>}
        {error && <p role="alert" className="executor-dialog-error">{error}</p>}
        {prepared && <section className="executor-preview">
          <h4>确认变更</h4>{prepared.summary.map(line => <p key={line}>{line}</p>)}
          {warning && <p className="executor-preview-warning">{warning}</p>}
          {markdown && <details><summary>查看助手能力说明</summary><pre>{markdown}</pre></details>}
        </section>}
        </div>
        <div className="model-connection-dialog-actions">
          <button className="ghost-button" type="button" disabled={saving} onClick={onClose}>取消</button>
          {prepared
            ? <button type="button" className="primary-button" disabled={locked} onClick={() => { void save(); }}>确认并热生效</button>
            : <button type="submit" className="primary-button" disabled={locked}>{saving ? '处理中…' : '预览变更'}</button>}
        </div>
      </form>
    </div>
  );
}
