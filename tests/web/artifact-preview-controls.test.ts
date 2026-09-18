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
