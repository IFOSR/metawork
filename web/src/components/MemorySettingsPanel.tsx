import { useCallback, useEffect, useState } from 'react';
import { memoryAssetViewState } from '../api/memory';
import type { MemoryApiClient, MemoryAssetListView, MemoryStatusView } from '../api/memory';

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
}

/**
 * Long-term memory settings.
 *
 * The switch is the product boundary: off means no sidecar, no request, no
 * model cost and no index. The extraction model is chosen explicitly from the
 * providers the user already configured; the panel never recommends one and
 * never fills it in.
 */
export function MemorySettingsPanel({ api, draft, onChange, disabled }: MemorySettingsPanelProps) {
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [assetView, setAssetView] = useState<MemoryAssetListView | null>(null);
  const assetState = memoryAssetViewState(assetView);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextAssets] = await Promise.all([
        api.status(),
        api.listAssets(),
      ]);
      setStatus(nextStatus);
      setAssetView(nextAssets);
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectable = (status?.selectableProviders ?? []).filter(provider => !provider.unsupportedReason);
  const unsupported = (status?.selectableProviders ?? []).filter(provider => provider.unsupportedReason);
  const currentProvider = selectable.find(provider => provider.providerRef === draft.providerRef);
  const models = (currentProvider?.models ?? []).filter(model => model.supportsStructuredOutput && model.enabled);

  const toggleAsset = async (memoryId: string, enabled: boolean) => {
    setBusy(true);
    try {
      await api.setAssetEnabled(memoryId, enabled);
      await refresh();
    } catch (toggleError) {
      setError((toggleError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteAsset = async (memoryId: string) => {
    setBusy(true);
    try {
      await api.deleteAsset(memoryId);
      await refresh();
    } catch (deleteError) {
      setError((deleteError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="memory-heading">
      <div className="section-heading">
        <div>
          <div className="settings-eyebrow">长期记忆</div>
          <h3 id="memory-heading">记忆</h3>
          <p>
            记忆会把跨会话的偏好与做法沉淀下来，并在以后的相关任务中被引用。
            记忆只在账号内共享；关闭后不会启动任何进程，也不会产生任何请求或费用。
          </p>
        </div>
      </div>

      {error && <div className="result-banner result-error">记忆面板加载失败：{error}</div>}

      <label className="memory-switch">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={event => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span>启用长期记忆</span>
      </label>

      {draft.enabled && (
        <div className="memory-model-picker">
          <label>
            抽取 Provider
            <select
              value={draft.providerRef}
              disabled={disabled}
              onChange={event => onChange({ ...draft, providerRef: event.target.value, modelRef: '' })}
            >
              <option value="">请选择 Provider</option>
              {selectable.map(provider => (
                <option key={provider.providerRef} value={provider.providerRef}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            抽取模型
            <select
              value={draft.modelRef}
              disabled={disabled || !draft.providerRef}
              onChange={event => onChange({ ...draft, modelRef: event.target.value })}
            >
              <option value="">请选择模型</option>
              {models.map(model => (
                <option key={model.modelRef} value={model.modelRef}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <p className="memory-note">
            记忆抽取会消耗所选 Provider 的额度
            {status?.modelPricing?.costInputPerMillion !== undefined
              ? `（输入约 ${status.modelPricing.costInputPerMillion}/百万 tokens）`
              : ''}
            。系统不会自动推荐或自动降级模型。
          </p>
          {unsupported.length > 0 && (
            <p className="memory-note">
              以下 Provider 不支持记忆抽取：
              {unsupported.map(provider => `${provider.displayName}（${provider.unsupportedReason}）`).join('、')}
            </p>
          )}
          {!status?.ftsAvailable && status && (
            <p className="memory-note memory-note-warning">
              记忆引擎的 BM25 检索不可用（FTS5 缺失），召回会静默失效，因此记忆暂不可用。
            </p>
          )}
        </div>
      )}

      <div className="memory-assets">
        <h4>记忆资产</h4>
        {assetState.kind === 'degraded'
          ? (
            <p role="status" className="memory-note memory-note-warning">
              记忆引擎不可用：{assetState.reason}。
              引擎恢复前无法显示或管理记忆资产。
            </p>
          )
          : assetState.kind === 'loading'
          ? <p role="status">正在加载记忆资产…</p>
          : assetState.kind === 'empty'
          ? <p role="status">还没有记忆资产。完成几轮对话后，沉淀出的偏好与做法会出现在这里。</p>
          : (
            <ul className="memory-asset-list">
              {assetState.items.map(asset => (
                <li key={asset.memoryId}>
                  <div className="memory-asset-body">
                    <span className="memory-asset-preview">{asset.preview}</span>
                    <span className="memory-asset-meta">
                      {asset.type}
                      {asset.workspaceId ? ` · 来自工作区 ${asset.workspaceId}` : ''}
                      {asset.enabled ? '' : ' · 已停用'}
                    </span>
                  </div>
                  <div className="memory-asset-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={disabled || busy}
                      onClick={() => { void toggleAsset(asset.memoryId, !asset.enabled); }}
                    >
                      {asset.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={disabled || busy}
                      onClick={() => { void deleteAsset(asset.memoryId); }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}
