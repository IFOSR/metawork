import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { ActivateResult } from '../api/types';
import { ProviderForm } from './ProviderForm';
import { ModelForm } from './ModelForm';
import { AgentClassForm } from './AgentClassForm';

interface SettingsPanelProps {
  http: HttpClient | null;
  onClose: () => void;
}

interface DraftState {
  providers: Record<string, Record<string, unknown>>;
  models: Record<string, Record<string, unknown>>;
  agentClasses: Record<string, Record<string, unknown>>;
}

export function SettingsPanel({ http, onClose }: SettingsPanelProps) {
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [result, setResult] = useState<ActivateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!http) return;
    void http.getConfig().then(snapshot => {
      const config = snapshot.config as Record<string, unknown>;
      setRevisionId(snapshot.revisionId);
      setDraft({
        providers: (config.providers ?? {}) as DraftState['providers'],
        models: (config.models ?? {}) as DraftState['models'],
        agentClasses: (config.agentClasses ?? {}) as DraftState['agentClasses'],
      });
    }).catch(error => setLoadError((error as Error).message));
  }, [http]);

  const activate = async () => {
    if (!http || !revisionId || !draft) return;
    setLoading(true);
    setResult(null);
    try {
      // 组装完整 config：draft 覆盖在原始 config 上。
      const original = await http.getConfig();
      const next = {
        ...(original.config as Record<string, unknown>),
        providers: draft.providers,
        models: draft.models,
        agentClasses: draft.agentClasses,
      };
      const response = await http.activate(revisionId, next);
      setResult(response);
      if (response.ok && response.revisionId) {
        setRevisionId(response.revisionId);
      }
    } catch (error) {
      setResult({ ok: false, code: 'network', issues: [(error as Error).message] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={event => event.stopPropagation()}>
        <div className="drawer-header">
          <span className="drawer-title">设置 · rev {revisionId ?? '…'}</span>
          <button className="ghost-button" onClick={onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <p className="settings-note">
            模型 ID 与凭证的权威是安装期配置（provider.env + 模板）；
            此处激活的 revision 影响 Kernel/Planner 的绑定、路由与开关行为。
            激活会真实探测 executor CLI（codex / pi），缺失会导致激活失败。
          </p>

          {loadError && <div className="result-banner result-error">加载失败：{loadError}</div>}

          {!draft && !loadError && <div className="empty-hint">加载配置中…</div>}

          {draft && (
            <>
              <h3 className="section-title">Provider</h3>
              <ProviderForm
                providers={draft.providers}
                onChange={providers => setDraft(prev => prev ? { ...prev, providers } : prev)}
              />

              <h3 className="section-title">Model</h3>
              <ModelForm
                models={draft.models}
                onChange={models => setDraft(prev => prev ? { ...prev, models } : prev)}
              />

              <h3 className="section-title">AgentClass</h3>
              <AgentClassForm
                agentClasses={draft.agentClasses}
                models={draft.models}
                onChange={agentClasses => setDraft(prev => prev ? { ...prev, agentClasses } : prev)}
              />

              {result && (
                <div className={`result-banner ${result.ok ? 'result-ok' : 'result-error'}`}>
                  {result.ok
                    ? `激活成功，新 revision ${result.revisionId}`
                    : `激活失败（${result.code ?? 'unknown'}）`}
                  {result.issues && result.issues.length > 0 && (
                    <ul className="issues">
                      {result.issues.map((issue, index) => <li key={index}>{issue}</li>)}
                    </ul>
                  )}
                  {result.code === 'revision_conflict' && (
                    <div className="dim">配置已被其他操作更新，请关闭设置后重新打开再试。</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {draft && (
          <div className="drawer-footer">
            <button className="ghost-button" onClick={onClose}>取消</button>
            <button className="primary-button" onClick={activate} disabled={loading}>
              {loading ? '激活中…' : '激活'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
