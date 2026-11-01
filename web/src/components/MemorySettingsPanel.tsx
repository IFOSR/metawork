import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  MemoryApiClient, MemoryAssetDetail, MemoryAssetListView, MemoryAssetView,
  MemoryEngineProblem, MemoryStatusView,
} from '../api/memory';

const ASSET_PAGE_SIZE = 50;
const TYPE_NAMES: Record<string, string> = {
  instruction: '偏好与要求', persona: '个人背景', episodic: '事件记录',
  knowledge: '知识', procedural: '做事方法',
};
const typeName = (type: string) => TYPE_NAMES[type] ?? '其他';
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN', { hour12: false });
};
const ENGINE_PROBLEM_NOTES: Record<MemoryEngineProblem, string> = {
  extraction_model_required: '请选择记忆抽取使用的 Provider 和模型；在此之前不会产生任何记忆请求或费用。',
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
  const [view, setView] = useState<MemoryAssetListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [layer, setLayer] = useState('');
  const [state, setState] = useState('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryAssetDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [deleting, setDeleting] = useState<MemoryAssetView | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const mutations = useRef(new Set<string>());
  const mounted = useRef(true);
  const drawer = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listController.current?.abort();
      detailController.current?.abort();
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (requestedOffset = 0) => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    try {
      const nextStatus = await api.status(controller.signal);
      let page: MemoryAssetListView | null = null;
      let nextOffset = requestedOffset;
      if (nextStatus.mode === 'enabled') {
        const input = {
          limit: ASSET_PAGE_SIZE, query, type, ...(layer ? { layer: layer as 'l1' | 'l2' | 'l3' } : {}),
          ...(state === 'all' ? {} : { enabled: state === 'on' }),
        };
        page = await api.listAssets({ ...input, offset: nextOffset }, controller.signal);
        if (!page.degraded && nextOffset > 0 && nextOffset >= page.total) {
          nextOffset = Math.max(0, Math.ceil(page.total / ASSET_PAGE_SIZE) - 1) * ASSET_PAGE_SIZE;
          page = await api.listAssets({ ...input, offset: nextOffset }, controller.signal);
        }
      }
      if (controller.signal.aborted) return;
      setStatus(nextStatus);
      setView(page);
      setOffset(nextOffset);
      setError(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api, query, type, layer, state]);

  useEffect(() => {
    void load();
    return () => listController.current?.abort();
  }, [load, configurationRevision]);

  useEffect(() => {
    detailController.current?.abort();
    if (!selectedId) { drawer.current?.close(); return; }
    const controller = new AbortController();
    detailController.current = controller;
    if (!drawer.current?.open) drawer.current?.showModal();
    setDetailLoading(true);
    setDetailError(null);
    void api.getAsset(selectedId, controller.signal).then(asset => {
      if (!controller.signal.aborted) setDetail(asset);
    }).catch(failure => {
      if (!controller.signal.aborted) setDetailError((failure as Error).message);
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [api, selectedId, detailRevision]);

  useEffect(() => {
    if (deleting) confirm.current?.showModal();
    else confirm.current?.close();
  }, [deleting]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  };

  const mutate = async (asset: MemoryAssetView, action: 'toggle' | 'delete') => {
    if (mutations.current.has(asset.memoryId)) return;
    mutations.current.add(asset.memoryId);
    setBusyIds(new Set(mutations.current));
    setDetailError(null);
    listController.current?.abort();
    detailController.current?.abort();
    try {
      if (action === 'toggle') await api.setAssetEnabled(asset.memoryId, !asset.enabled);
      else await api.deleteAsset(asset.memoryId);
      if (!mounted.current) return;
      if (action === 'toggle') {
        setDetail(current => current?.memoryId === asset.memoryId ? { ...current, enabled: !asset.enabled } : current);
        setView(current => current ? { ...current, items: current.items.map(item => item.memoryId === asset.memoryId
          ? { ...item, enabled: !asset.enabled } : item) } : current);
        setNotice(asset.enabled ? '已停用这条记忆' : '已恢复使用这条记忆');
      } else {
        setView(current => current ? { ...current, items: current.items.filter(item => item.memoryId !== asset.memoryId),
          total: Math.max(0, current.total - 1),
          unfilteredTotal: current.unfilteredTotal === undefined ? undefined : Math.max(0, current.unfilteredTotal - 1),
        } : current);
        setDeleting(null);
        if (selectionRef.current === asset.memoryId) {
          closeDetail();
          searchInput.current?.focus();
        }
        setNotice('记忆已删除');
      }
      await loadRef.current(offsetRef.current);
    } catch (failure) {
      if (mounted.current) {
        const message = `操作失败：${(failure as Error).message}`;
        if (selectionRef.current === asset.memoryId) setDetailError(message);
        else setNotice(message);
      }
    } finally {
      mutations.current.delete(asset.memoryId);
      if (mounted.current) setBusyIds(new Set(mutations.current));
    }
  };

  const refresh = () => {
    void load(offset);
    if (selectedId) setDetailRevision(value => value + 1);
  };
  const selectable = (status?.selectableProviders ?? []).filter(provider => !provider.unsupportedReason);
  const unsupported = (status?.selectableProviders ?? []).filter(provider => provider.unsupportedReason);
  const provider = selectable.find(item => item.providerRef === draft.providerRef);
  const models = (provider?.models ?? []).filter(model => model.supportsStructuredOutput && model.enabled);
  const engineNote = memoryEngineProblemNote(status?.engineProblem);
  const mode = status?.mode;
  const modeLabel = mode === 'enabled' ? '长期记忆已开启' : mode === 'disabled' ? '记忆已关闭'
    : mode === 'needs-model' ? '需要设置抽取模型' : mode === 'degraded' ? '记忆暂不可用' : '正在读取状态';
  const hasFilters = Boolean(query || type || layer || state !== 'all');
  const pending = status && (draft.enabled !== (status.mode !== 'disabled')
    || (draft.enabled && (draft.providerRef !== (status.providerRef ?? '') || draft.modelRef !== (status.modelRef ?? ''))));
  const currentDetail = detail?.memoryId === selectedId ? detail : null;
  const detailBusy = selectedId ? busyIds.has(selectedId) : false;

  return (
    <section className="settings-section memory-panel" aria-labelledby="memory-heading">
      <header className="memory-heading">
        <div><h3 id="memory-heading">记忆</h3><p>查看 MetaWork 记住的偏好、背景和事件。</p></div>
        <div className="memory-heading-actions">
          <span className="memory-runtime-status" data-mode={mode}>{modeLabel}</span>
          <button type="button" className="ghost-button" aria-expanded={settingsOpen} aria-controls="memory-configuration"
            onClick={() => setSettingsOpen(value => !value)}>记忆设置</button>
        </div>
      </header>
      {settingsOpen && <div id="memory-configuration" className="memory-configuration">
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
          <p className="memory-note">记忆整理使用所选模型的额度
            {status?.modelPricing?.costInputPerMillion !== undefined ? `（输入约 ${status.modelPricing.costInputPerMillion}/百万 tokens）` : ''}。
          </p>
          {provider && models.length === 0 && <p className="memory-note memory-note-warning">此模型服务下没有可用的抽取模型，请先添加支持结构化输出的模型。</p>}
          {unsupported.length > 0 && <details><summary>查看不支持的模型服务</summary><ul>
            {unsupported.map(item => <li key={item.providerRef}>{item.displayName}：{item.unsupportedReason === 'provider_disabled'
              ? '尚未启用' : '当前记忆引擎暂不支持此连接协议'}</li>)}
          </ul></details>}
        </div>}
      </div>}
      <p className="memory-scope">这些记忆仅用于当前账号，可在不同工作区的相关任务中使用。</p>
      {engineNote && <p className="memory-note memory-note-warning">{engineNote}</p>}
      <div className="memory-assets">
        <h4 className="sr-only">已保存的记忆</h4>
        <div className="memory-toolbar">
          <input ref={searchInput} type="search" className="text-input" aria-label="搜索记忆内容" placeholder="搜索记忆内容…"
            value={search} onChange={event => setSearch(event.target.value)} disabled={mode !== 'enabled'} />
          <select aria-label="按记忆类型筛选" value={type} onChange={event => setType(event.target.value)} disabled={mode !== 'enabled'}>
            <option value="">全部类型</option>{Object.entries(TYPE_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="按记忆层级筛选" value={layer} onChange={event => { setLayer(event.target.value); setOffset(0); }} disabled={mode !== 'enabled'}>
            <option value="">全部层级</option><option value="l1">L1 原子记忆</option><option value="l2">L2 场景经验</option><option value="l3">L3 用户画像</option>
          </select>
          <select aria-label="按记忆状态筛选" value={state} onChange={event => setState(event.target.value)} disabled={mode !== 'enabled'}>
            <option value="all">全部状态</option><option value="on">可使用</option><option value="off">已停用</option>
          </select>
          <button type="button" className="ghost-button memory-refresh" disabled={loading} onClick={refresh}>{loading ? '读取中…' : '刷新'}</button>
        </div>
        {error && <div className="memory-error" role="alert">{view ? '刷新失败，当前内容可能不是最新。' : '记忆读取失败。'} {error}</div>}
        <p className="memory-notice" role="status">{notice}</p>
        {mode === 'disabled' ? <p className="memory-empty">记忆已关闭。开启后可查看和管理已保存的记忆。</p>
          : mode === 'needs-model' ? <p className="memory-empty">请在“记忆设置”中选择抽取模型，并保存激活。</p>
          : mode === 'degraded' || view?.degraded ? <p className="memory-empty">记忆暂不可用。请检查记忆设置，或点击刷新重试。</p>
          : !view ? <div className="memory-empty" role="status">{loading ? '正在读取记忆…' : '未能读取记忆，请重试。'}</div>
          : <>
            <div className="memory-list-summary"><span role="status">{hasFilters
              ? `找到 ${view.total} 条，共 ${view.unfilteredTotal ?? view.total} 条` : `共 ${view.total} 条`}
              {view.total > ASSET_PAGE_SIZE ? `，当前显示 ${offset + 1}–${offset + view.items.length} 条` : ''}</span>
              <span>点击记忆查看详情</span></div>
            {view.items.length === 0 ? <div className="memory-empty"><p>{hasFilters ? '没有找到相关记忆' : '还没有保存的记忆。相关对话会在后台整理为记忆。'}</p>
              {hasFilters && <button type="button" className="ghost-button" onClick={() => { setSearch(''); setQuery(''); setType(''); setLayer(''); setState('all'); }}>清除筛选</button>}</div>
              : <ul className="memory-asset-list">{view.items.map(asset => <li key={asset.memoryId}>
                <button type="button" className="memory-row" data-selected={selectedId === asset.memoryId}
                  onClick={() => { setDetail(null); setSelectedId(asset.memoryId); }}>
                  <span className="memory-type-icon" aria-hidden="true">{asset.type === 'instruction' ? '≡' : asset.type === 'persona' ? '◎' : '◷'}</span>
                  <span className="memory-asset-body"><span className="memory-asset-preview">{asset.preview}</span>
                    <span className="memory-asset-meta"><span>{asset.layer.toUpperCase()} · {asset.title || typeName(asset.type)}</span><span className="memory-badge" data-enabled={asset.enabled}>{asset.enabled ? '可使用' : '已停用'}</span></span>
                  </span><span className="memory-row-arrow" aria-hidden="true">›</span>
                </button>
              </li>)}</ul>}
            {(offset > 0 || view.total > ASSET_PAGE_SIZE) && <nav className="memory-pagination" aria-label="记忆资产分页">
              <button type="button" className="ghost-button" disabled={loading || offset === 0} onClick={() => { void load(offset - ASSET_PAGE_SIZE); }}>上一页</button>
              <span>第 {Math.floor(offset / ASSET_PAGE_SIZE) + 1} 页</span>
              <button type="button" className="ghost-button" disabled={loading || offset + ASSET_PAGE_SIZE >= view.total} onClick={() => { void load(offset + ASSET_PAGE_SIZE); }}>下一页</button>
            </nav>}
          </>}
        <p className="memory-note memory-list-footnote">可使用的记忆会在相关任务中被检索，不代表每次任务都会引用。</p>
      </div>
      {createPortal(<>
        <dialog ref={drawer} className="memory-detail-dialog" aria-labelledby="memory-detail-title"
          onCancel={event => { event.preventDefault(); closeDetail(); }} onClick={event => { if (event.target === event.currentTarget) closeDetail(); }}>
          <header><h3 id="memory-detail-title">记忆详情</h3><button type="button" className="ghost-button" autoFocus onClick={closeDetail} aria-label="关闭记忆详情">返回记忆</button></header>
          <div className="memory-detail-body">
            {detailLoading && !currentDetail && <p role="status">正在读取全文…</p>}
            {detailError && <div className="memory-error" role="alert">{detailError}<button type="button" className="ghost-button" onClick={() => setDetailRevision(value => value + 1)}>重新读取</button></div>}
            {currentDetail && <>
              <div className="memory-asset-meta"><span>{typeName(currentDetail.type)}</span><span className="memory-badge" data-enabled={currentDetail.enabled}>{currentDetail.enabled ? '可使用' : '已停用'}</span></div>
              <p className="memory-full-content">{currentDetail.content}</p>
              <button type="button" className="ghost-button" onClick={() => { void navigator.clipboard.writeText(currentDetail.content)
                .then(() => setNotice('已复制全文')).catch(() => setDetailError('复制失败，请选中正文后复制。')); }}>复制全文</button>
              <div className="memory-detail-rule" />
              <label className="memory-usage-toggle"><span>允许在相关任务中使用</span><input type="checkbox" role="switch"
                checked={currentDetail.enabled} disabled={detailBusy} onChange={() => { void mutate(currentDetail, 'toggle'); }} /></label>
              <p className="memory-note">关闭后保留这条记忆，后续不再作为新的记忆证据提供给任务。不会撤回已发送给运行中任务的内容。</p>
              <div className="memory-detail-rule" /><dl className="memory-detail-facts">
                <dt>作用范围</dt><dd>当前账号的所有工作区</dd><dt>来源</dt><dd>{currentDetail.source === 'sanitized' ? '对话整理（已净化）' : '对话整理；来源会话未记录'}</dd>
                <dt>更新时间</dt><dd>{dateLabel(currentDetail.updatedAt)}</dd>
              </dl>
            </>}
          </div>
          <footer><button type="button" className="ghost-button memory-delete" disabled={!currentDetail || detailBusy}
            onClick={() => setDeleting(currentDetail)}>删除记忆</button><span className="memory-note" role="status">{detailBusy ? '正在保存…' : notice}</span><button type="button" className="ghost-button" onClick={closeDetail}>完成</button></footer>
        </dialog>
        <dialog ref={confirm} className="memory-delete-dialog" aria-labelledby="memory-delete-title"
          onCancel={event => { event.preventDefault(); if (!deleting || !busyIds.has(deleting.memoryId)) setDeleting(null); }}>
          <h3 id="memory-delete-title">删除这条记忆？</h3><p className="memory-delete-excerpt">{deleting?.preview}</p>
          <p>删除后无法恢复，不影响原始对话和已生成的文件。</p>
          {detailError && <p className="memory-error" role="alert">{detailError}</p>}
          <div className="memory-delete-actions"><button type="button" className="ghost-button" autoFocus disabled={Boolean(deleting && busyIds.has(deleting.memoryId))}
            onClick={() => setDeleting(null)}>取消</button><button type="button" className="primary-button memory-delete-confirm"
              disabled={!deleting || busyIds.has(deleting.memoryId)} onClick={() => { if (deleting) void mutate(deleting, 'delete'); }}>{deleting && busyIds.has(deleting.memoryId) ? '删除中…' : '删除记忆'}</button></div>
        </dialog>
      </>, document.body)}
    </section>
  );
}
