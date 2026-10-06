import { useState } from 'react';
import type { HttpClient } from '../api/http';
import type {
  ExecutorConfigurationChange, ExecutorEditableFields, ExecutorManagementView,
  ExecutorToolId, PreparedExecutorConfiguration,
} from '../api/types';

interface Props {
  http: HttpClient;
  view: ExecutorManagementView;
  agentClassRef?: string;
  operation: ExecutorConfigurationChange['operation'];
  disabled: boolean;
  onClose(): void;
  config: Record<string, unknown>;
  onSaved(candidate: PreparedExecutorConfiguration, agentClassRef: string): void;
  onRemoved(agentClassRef: string): void;
  onEnabled(agentClassRef: string, enabled: boolean): void;
}

const labels = { create: '新增', update: '编辑', enable: '启用', disable: '停用', remove: '删除' };

export function ExecutorEditorDialog({ http, view, agentClassRef, operation, disabled, config, onClose, onSaved, onRemoved, onEnabled }: Props) {
  const existing = view.executors.find(agent => agent.agentClassRef === agentClassRef);
  const [tool, setTool] = useState<ExecutorToolId>(existing?.tool ?? 'pi');
  const [fields, setFields] = useState<ExecutorEditableFields>(() => ({
    displayName: existing?.displayName ?? '',
    modelPolicy: existing?.modelPolicy ?? { mode: 'fixed', modelRef: '' },
    manualSourceText: existing?.manualSourceText ?? '',
    enabled: existing?.enabled ?? true,
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = operation === 'create' || operation === 'update';
  const toggling = operation === 'enable' || operation === 'disable';
  const locked = disabled || saving;
  const models = view.tools.find(entry => entry.id === tool)?.models ?? [];
  const update = (patch: Partial<ExecutorEditableFields>) => {
    setFields(current => ({ ...current, ...patch }));
    setError('');
  };
  const save = async () => {
    if (locked) return;
    if (operation === 'remove') {
      onRemoved(agentClassRef!);
      return;
    }
    if (toggling) {
      onEnabled(agentClassRef!, operation === 'enable');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const change: ExecutorConfigurationChange = operation === 'create'
        ? { operation, tool, fields }
        : { operation: 'update', agentClassRef: agentClassRef!, fields };
      const candidate = await http.prepareExecutor(view.baseRevisionId, change, config);
      onSaved(candidate, candidate.createdAgentClassRef ?? agentClassRef!);
    } catch (failure) {
      setError((failure as Error).message);
    } finally { setSaving(false); }
  };
  return (
    <div className="modal-backdrop">
      <form className="model-connection-dialog executor-editor-dialog" role="dialog" aria-modal="true"
        aria-labelledby="executor-editor-title" onSubmit={event => {
          event.preventDefault();
          void save();
        }}>
        <div className="model-connection-dialog-heading">
          <div><h3 id="executor-editor-title">{labels[operation]}智能体</h3>
            <p>保存到当前设置草稿；点击页面底部“保存并激活”后统一生效。</p></div>
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
          <p className="executor-dialog-notice">{existing?.operations === 'restricted'
            ? '此智能体保留系统设置的操作限制；编辑职责不会改变这些限制。'
            : '可使用已配置工具访问公共资料、处理任务文件；敏感操作由系统统一授权。'}</p>
          <label className="settings-field"><span>职责</span>
            <textarea className="text-input" rows={4} maxLength={8000} value={fields.manualSourceText}
              onChange={event => update({ manualSourceText: event.target.value })} /></label>
          <label className="executor-enable-row">
            <input type="checkbox" checked={fields.enabled} onChange={event => update({ enabled: event.target.checked })} />
            <span>启用此智能体</span></label>
        </fieldset> : <p className="executor-confirm-text">确认{labels[operation]}“{existing?.displayName}”？{operation === 'remove' && '历史工作和文件会保留；删除后不能再分配新工作给它。'}</p>}
        {disabled && <p role="status" className="executor-dialog-notice">正在处理配置，请稍候。输入已保留。</p>}
        {error && <p role="alert" className="executor-dialog-error">{error}</p>}
        </div>
        <div className="model-connection-dialog-actions">
          <button className="ghost-button" type="button" disabled={saving} onClick={onClose}>取消</button>
          {operation === 'remove'
            ? <button type="button" className="primary-button" disabled={locked} onClick={() => { void save(); }}>确认删除</button>
            : toggling
            ? <button type="button" className="primary-button" disabled={locked} onClick={() => { void save(); }}>确认{labels[operation]}</button>
            : <button type="submit" className="primary-button" disabled={locked}>{saving ? '保存中…' : '保存'}</button>}
        </div>
      </form>
    </div>
  );
}
