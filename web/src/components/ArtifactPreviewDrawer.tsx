import type { ArtifactProjection } from '../api/session-types';
import type { HttpClient } from '../api/http';
import { formatBytes } from './ArtifactLink';
import { MarkdownContent } from './MarkdownContent';

export type PreviewDrawerState =
  | { status: 'closed' }
  | { status: 'loading'; artifactId: string }
  | { status: 'error'; artifactId: string; message: string }
  | {
    status: 'ready';
    artifact: ArtifactProjection;
    content: string;
    renderedHtml?: string;
  };

const FAILURE_MESSAGES: Record<string, string> = {
  not_found: '找不到该产物，或它已被删除。',
  unauthorized: '当前账户无权访问该产物。',
  unavailable: '历史产物不可用：源文件缺失或已被清理。',
  unsupported: '该文件类型不支持预览，可尝试下载查看。',
};

export function ArtifactPreviewDrawer({
  http,
  state,
  collapsed,
  onClose,
  onToggleCollapse,
}: {
  http: HttpClient | null;
  state: PreviewDrawerState;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
}) {
  if (state.status === 'closed') return null;

  const header = (
    <header className="artifact-drawer-header">
      <div className="artifact-drawer-title">
        <span>DOCUMENT PREVIEW</span>
        <strong>
          {state.status === 'ready'
            ? state.artifact.displayName
            : '正在打开文档…'}
        </strong>
        {state.status === 'ready' && (
          <small>{state.artifact.relativePath} · {formatBytes(state.artifact.byteLength)}</small>
        )}
      </div>
      <div className="artifact-drawer-actions">
        {state.status === 'ready' && (
          <>
            <button
              type="button"
              className="artifact-drawer-collapse"
              onClick={onToggleCollapse}
              title={collapsed ? '展开预览' : '收起预览'}
            >
              {collapsed ? '⟨' : '⟩'}
            </button>
            {http && (
              <a
                className="artifact-drawer-download"
                href={http.artifactDownloadUrl(state.artifact.artifactId)}
                download={state.artifact.displayName}
                title="下载"
              >
                ⬇
              </a>
            )}
          </>
        )}
        <button
          type="button"
          className="artifact-drawer-close"
          onClick={onClose}
          aria-label="关闭预览"
          title="关闭（Esc）"
        >
          ✕
        </button>
      </div>
    </header>
  );

  return (
    <aside
      className={`artifact-preview-drawer${collapsed ? ' is-collapsed' : ''}`}
      data-testid="artifact-preview-drawer"
    >
      {header}
      {!collapsed && (
        <div className="artifact-drawer-body">
          <DrawerBody state={state} />
        </div>
      )}
      {collapsed && (
        <div className="artifact-drawer-collapsed-hint" onClick={onToggleCollapse}>
          点击展开
        </div>
      )}
    </aside>
  );
}

function DrawerBody({ state }: { state: PreviewDrawerState }) {
  if (state.status === 'loading') {
    return (
      <div className="artifact-preview-loading" role="status">正在加载文档…</div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="artifact-preview-error" role="alert">
        {FAILURE_MESSAGES[state.message] ?? state.message}
      </div>
    );
  }
  if (state.status !== 'ready') return null;

  if (!state.artifact.previewable || state.artifact.previewKind === 'unsupported') {
    return (
      <div className="artifact-preview-unsupported">
        <p>该文件类型不支持同源预览。</p>
        <dl>
          <dt>文件</dt><dd>{state.artifact.displayName}</dd>
          <dt>路径</dt><dd>{state.artifact.relativePath}</dd>
          <dt>类型</dt><dd>{state.artifact.mediaType}</dd>
          <dt>大小</dt><dd>{formatBytes(state.artifact.byteLength)}</dd>
        </dl>
      </div>
    );
  }
  if (state.renderedHtml) {
    // 服务端安全渲染结果；与 MarkdownContent 同级信任边界。
    return (
      <div
        className="markdown-content artifact-preview-markdown"
        dangerouslySetInnerHTML={{ __html: state.renderedHtml }}
      />
    );
  }
  if (state.artifact.previewKind === 'markdown') {
    return <MarkdownContent value={state.content} />;
  }
  if (state.artifact.previewKind === 'code') {
    return (
      <pre className="artifact-preview-code"><code>{state.content}</code></pre>
    );
  }
  // previewKind === 'text'
  return (
    <pre className="artifact-preview-text">{state.content}</pre>
  );
}
