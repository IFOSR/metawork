import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  MemoryApiClient, MemoryAssetDetail, MemoryAssetListView, MemoryAssetView,
  MemoryStatusView,
} from '../api/memory';
import { memoryEngineProblemNote } from './MemorySettingsPanel';
import { MarkdownContent } from './MarkdownContent';
import { markdownPreview } from '../markdown-preview';
import { loadMemoryProfile, type MemoryProfile } from '../memory-profile';

/** One page of memory assets; the list never grows without bound. */
const ASSET_PAGE_SIZE = 10;
const TYPE_NAMES: Record<string, string> = {
  instruction: '偏好与要求', persona: '个人背景', episodic: '事件记录',
  knowledge: '知识', procedural: '做事方法',
};
const typeName = (type: string) => TYPE_NAMES[type] ?? '其他';
const LAYER_NAMES: Record<'l1' | 'l2' | 'l3', string> = { l1: '原子记忆', l2: '场景经验', l3: '用户画像' };
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN', { hour12: false });
};
export interface MemoryAssetsPanelProps {
  api: MemoryApiClient;
  onOpenSettings: () => void;
  configurationRevision?: string;
}

export function MemoryAssetsPanel({ api, onOpenSettings, configurationRevision }: MemoryAssetsPanelProps) {
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [view, setView] = useState<MemoryAssetListView | null>(null);
  const [profile, setProfile] = useState<MemoryProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profilePartial, setProfilePartial] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [layer, setLayer] = useState('');
  const [state, setState] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryAssetDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [deleting, setDeleting] = useState<MemoryAssetView | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportController = useRef<AbortController | null>(null);
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
      exportController.current?.abort();
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
    const controller = new AbortController();
    if (status?.mode !== 'enabled') {
      setProfile(null);
      setProfileLoading(false);
      setProfileError(null);
      return;
    }
    setProfileLoading(true);
    setProfileError(null);
    void loadMemoryProfile(api, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setProfile(result.profile);
        setProfilePartial(result.partial);
      }
    }).catch(failure => {
      if (!controller.signal.aborted) {
        setProfile(null);
        setProfileError((failure as Error).message);
      }
    }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    return () => controller.abort();
  }, [api, status?.mode, configurationRevision, profileRevision]);

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
      setProfileRevision(value => value + 1);
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

  const exportMemory = async () => {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const pack = await api.exportAssets(controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `metawork-memory-${pack.exportedAt.slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(`已导出当前账号全部 ${pack.total} 条记忆（包含停用条目）`);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        const message = (failure as Error).message;
        setExportError(message.includes('memory_export_too_large') ? '记忆包超过导出上限（10,000 条或 32 MiB），本次未生成文件。'
          : message.includes('memory_export_busy') ? '已有导出正在进行，请稍后重试。'
          : message.includes('memory_export_changed') || message.includes('memory_asset_listing_incomplete')
            ? '导出期间记忆列表发生变化或不完整，请重试。' : `导出失败，请重试：${message}`);
      }
    } finally {
      exportController.current = null;
      if (mounted.current) setExporting(false);
    }
  };

  const refresh = () => {
    setProfileRevision(value => value + 1);
    void load(offset);
    if (selectedId) setDetailRevision(value => value + 1);
  };
  const engineNote = memoryEngineProblemNote(status?.engineProblem);
  const mode = status?.mode;
  const modeLabel = mode === 'enabled' ? '长期记忆已开启' : mode === 'disabled' ? '记忆已关闭'
    : mode === 'needs-model' ? '需要设置抽取模型' : mode === 'degraded' ? '记忆暂不可用' : '正在读取状态';
  const hasFilters = Boolean(query || type || layer || state !== 'all');
  const currentDetail = detail?.memoryId === selectedId ? detail : null;
  const detailBusy = selectedId ? busyIds.has(selectedId) : false;

  return (
    <section className="memory-panel memory-workspace" aria-labelledby="memory-heading">
      <header className="memory-heading">
        <div><h2 id="memory-heading">记忆</h2><p>查看 MetaWork 记住的偏好、背景和事件。</p></div>
        <div className="memory-heading-actions">
          <span className="memory-runtime-status" data-mode={mode}>{modeLabel}</span>
          <button type="button" className="ghost-button" disabled={mode !== 'enabled' || exporting}
            title="导出当前账号全部记忆，包含停用条目，不受筛选条件影响" onClick={() => void exportMemory()}>{exporting ? '导出中…' : '导出全部记忆'}</button>
          {exporting && <button type="button" className="ghost-button" onClick={() => exportController.current?.abort()}>取消导出</button>}
          <button type="button" className="ghost-button" onClick={onOpenSettings}>记忆设置</button>
        </div>
      </header>
      <p className="memory-scope">这些记忆仅用于当前账号，可在不同工作区的相关任务中使用。</p>
      {engineNote && <p className="memory-note memory-note-warning">{engineNote}</p>}
      {exportError && <p className="memory-error" role="alert">{exportError}</p>}
      {mode === 'enabled' && profile && <section className="memory-profile" aria-labelledby="memory-profile-title" aria-busy={profileLoading}>
        <header><div><span className="memory-profile-kicker">ACCOUNT MEMORY</span><h3 id="memory-profile-title">记忆画像</h3>
          <p>{profile.portrait}</p><p className="memory-profile-footnote">{profilePartial ? '部分记忆概览 · ' : ''}包含停用条目 · {profileLoading ? '正在更新…' : '当前账号'}</p></div><div className="memory-profile-total"><strong>{profile.total}</strong><span>条记忆 · {profile.enabled} 条可使用</span></div></header>
        <div className="memory-profile-grid">
          <div className="memory-layer-overview" aria-label="记忆层级分布">
            {([['l1', '原子记忆', '具体偏好与事实'], ['l2', '场景经验', '反复出现的经验'], ['l3', '用户画像', '稳定的个人特征']] as const).map(([key, label, note]) => <div className="memory-layer-stat" key={key}>
              <span className="memory-layer-badge" data-layer={key}>{key.toUpperCase()}</span><strong>{profile.layers[key]}</strong><span>{label}</span><small>{note}</small>
            </div>)}
          </div>
          <div className="memory-topic-overview"><h4>主要内容</h4>{profile.topics.length ? profile.topics.slice(0, 5).map(topic => <div className="memory-topic-row" key={topic.label}>
            <span>{topic.label}</span><span className="memory-topic-track"><i style={{ width: `${Math.max(4, topic.count / Math.max(...profile.topics.map(item => item.count)) * 100)}%` }} /></span><strong>{topic.count}</strong>
          </div>) : <p>暂无主题数据</p>}</div>
        </div>
        {profile.highlights.length > 0 && <div className="memory-profile-highlights" aria-label="已记住的内容摘要">
          {profile.highlights.map(asset => <button type="button" key={asset.memoryId} onClick={() => { setDetail(null); setSelectedId(asset.memoryId); }}>
            <span className="memory-highlight-label"><span className="memory-layer-badge" data-layer={asset.layer}>{asset.layer.toUpperCase()} {LAYER_NAMES[asset.layer]}</span><span>{asset.enabled ? '可使用' : '已停用'}</span></span>
            <strong>{asset.title && asset.title !== asset.type ? asset.title : typeName(asset.type)}</strong>
            <span className="memory-highlight-preview">{markdownPreview(asset.preview, 180)}</span><span className="memory-highlight-link">查看原文 →</span>
          </button>)}
        </div>}
        <p className="memory-profile-footnote">主题根据已保存的标题与摘要归类，一条记忆可涉及多个主题。以上摘要保留原文含义，可打开核对。</p>
        <div className="memory-profile-types"><span>信息类型</span>{profile.types.slice(0, 5).map(item => <span key={item.label}>{item.label} <strong>{item.count}</strong></span>)}</div>
        {profilePartial && <p className="memory-profile-footnote">记忆超过统计上限或读取期间发生变化，上述为部分内容，请刷新重试。</p>}
      </section>}
      {mode === 'enabled' && !profile && profileLoading && <p className="memory-note" role="status">正在整理记忆画像…</p>}
      {mode === 'enabled' && !profile && profileError && <p className="memory-error" role="alert">记忆画像读取失败：{profileError} <button type="button" className="ghost-button" onClick={() => setProfileRevision(value => value + 1)}>重试画像</button></p>}
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
          : mode === 'needs-model' ? <p className="memory-empty">请打开“记忆设置”选择抽取模型，并保存激活。</p>
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
                  <span className="memory-asset-body"><span className="memory-asset-preview">{markdownPreview(asset.preview, 220)}</span>
                    <span className="memory-asset-meta">
                      <span className="memory-layer-badge" data-layer={asset.layer}>{asset.layer.toUpperCase()} {LAYER_NAMES[asset.layer]}</span>
                      <span>{asset.title || typeName(asset.type)}</span>
                      <span className="memory-asset-time">{dateLabel(asset.updatedAt)}</span>
                      <span className="memory-badge" data-enabled={asset.enabled}>{asset.enabled ? '可使用' : '已停用'}</span>
                    </span>
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
              <div className="memory-asset-meta">
                <span className="memory-layer-badge" data-layer={currentDetail.layer}>{currentDetail.layer.toUpperCase()} {LAYER_NAMES[currentDetail.layer]}</span>
                <span>{typeName(currentDetail.type)}</span>
                <span className="memory-asset-time">{dateLabel(currentDetail.updatedAt)}</span>
                <span className="memory-badge" data-enabled={currentDetail.enabled}>{currentDetail.enabled ? '可使用' : '已停用'}</span>
              </div>
              <div className="memory-full-content"><MarkdownContent value={currentDetail.content} /></div>
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
