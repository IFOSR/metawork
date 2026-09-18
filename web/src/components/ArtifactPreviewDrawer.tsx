import type { PointerEvent as ReactPointerEvent } from 'react';
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
  maximized,
  width,
  onClose,
  onToggleCollapse,
  onToggleMaximize,
  onResize,
}: {
  http: HttpClient | null;
  state: PreviewDrawerState;
  collapsed: boolean;
  /** 铺满工作区主体，用于阅读长文档。 */
  maximized?: boolean;
  /** 用户拖动调宽后的像素宽度；为空时使用默认三列布局。 */
  width?: number | null;
  onClose: () => void;
  onToggleCollapse: () => void;
  onToggleMaximize?: () => void;
  onResize?: (width: number) => void;
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
            {!collapsed && onToggleMaximize && (
              <button
                type="button"
                className="artifact-drawer-maximize"
                onClick={onToggleMaximize}
                aria-pressed={maximized ? true : undefined}
                title={maximized ? '还原预览宽度' : '最大化预览'}
              >
                {maximized ? '⤡' : '⤢'}
              </button>
            )}
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

  const resizable = !collapsed && !maximized && typeof onResize === 'function';
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const onMove = (move: PointerEvent) => {
      // 向左拖动变宽：抽屉在右侧，宽度 = 起始宽度 + 反向位移。
      const next = Math.round(startWidth + (startX - move.clientX));
      onResize?.(next);
    };
    const onUp = () => {
      ownerWindow.removeEventListener('pointermove', onMove);
      ownerWindow.removeEventListener('pointerup', onUp);
    };
    ownerWindow.addEventListener('pointermove', onMove);
    ownerWindow.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      className={`artifact-preview-drawer${collapsed ? ' is-collapsed' : ''}`}
      data-testid="artifact-preview-drawer"
      data-maximized={maximized ? 'true' : undefined}
      style={!collapsed && !maximized && typeof width === 'number'
        ? { flexBasis: `${width}px` }
        : undefined}
    >
      {resizable && (
        <div
          className="artifact-drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整预览宽度"
          title="拖动调整预览宽度"
          onPointerDown={startResize}
        />
      )}
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
  if (state.artifact.previewKind === 'image') {
    return (
      <div className="artifact-preview-image-wrap">
        <img
          className="artifact-preview-image"
          src={state.content}
          alt={state.artifact.displayName}
        />
      </div>
    );
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
