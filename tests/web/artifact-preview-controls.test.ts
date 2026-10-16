import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactPreviewDrawer } from '../../web/src/components/ArtifactPreviewDrawer';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(ArtifactPreviewDrawer, {
    http: null,
    state: {
      status: 'ready',
      artifact: {
        artifactId: 'artifact_1',
        displayName: '股市联动解释.md',
        relativePath: '股市联动解释.md',
        mediaType: 'text/markdown',
        byteLength: 10_485,
        previewable: true,
        previewKind: 'markdown',
      },
      content: '# 标题',
      renderedHtml: '<h1>标题</h1>',
    },
    collapsed: false,
    onClose: vi.fn(),
    onToggleCollapse: vi.fn(),
    ...overrides,
  } as never));
}

describe('Artifact preview controls', () => {
  it('isolates rich documents in a sandbox with no same-origin privileges and retains download', () => {
    const html = render({ http: { artifactDownloadUrl: () => '/api/artifacts/ppt-id/download' },
      state: { status: 'ready', content: 'data:application/octet-stream;base64,AA==', artifact: {
        artifactId: 'ppt-id', displayName: '销售方案.pptx', relativePath: '销售方案.pptx',
        mediaType: 'application/octet-stream', byteLength: 32000,
        previewable: true, previewKind: 'unsupported', documentFormat: 'pptx',
      } } });
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('销售方案.pptx 预览');
    expect(html).toContain('下载原文件');
  });

  it('shows PPT file details and the original download even without preview support', () => {
    const html = render({
      http: { artifactDownloadUrl: () => '/api/artifacts/ppt-id/download' },
      state: { status: 'ready', content: '', artifact: {
        artifactId: 'ppt-id', displayName: '销售方案.pptx', relativePath: '销售方案.pptx',
        mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        byteLength: 32000, previewable: false, previewKind: 'unsupported',
      } },
    });
    expect(html).toContain('销售方案.pptx');
    expect(html).toContain('下载原文件');
    expect(html).toContain('/api/artifacts/ppt-id/download');
    expect(html).toContain('PowerPoint、Keynote 或 WPS');
    expect(html).not.toContain('正在打开文档');
  });

  it('stops announcing loading when opening the file fails', () => {
    const html = render({ state: { status: 'error', artifactId: 'missing', message: 'not_found' } });
    expect(html).toContain('无法打开预览');
    expect(html).toContain('找不到该产物');
    expect(html).not.toContain('正在打开文档');
  });

  it('offers a maximize control that toggles back to the default width', () => {
    const normal = render({ onToggleMaximize: vi.fn() });
    expect(normal).toContain('最大化预览');
    expect(normal).not.toContain('data-maximized="true"');

    const maximized = render({ onToggleMaximize: vi.fn(), maximized: true });
    expect(maximized).toContain('还原预览宽度');
    expect(maximized).toContain('data-maximized="true"');
  });

  it('exposes a drag handle that resizes the drawer', () => {
    const html = render({ onResize: vi.fn() });
    expect(html).toContain('role="separator"');
    expect(html).toContain('拖动调整预览宽度');
  });

  it('applies a dragged width and hides the handle when maximized', () => {
    const sized = render({ onResize: vi.fn(), width: 900 });
    expect(sized).toContain('flex-basis:900px');

    const maximized = render({ onResize: vi.fn(), width: 900, maximized: true });
    expect(maximized).not.toContain('flex-basis:900px');
    expect(maximized).not.toContain('拖动调整预览宽度');
  });
});
