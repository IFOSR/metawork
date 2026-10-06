import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ExecutorEditorDialog } from '../../web/src/components/ExecutorEditorDialog';
import { HttpClient } from '../../web/src/api/http';
import type { ExecutorManagementView } from '../../web/src/api/types';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Executor availability confirmation', () => {
  it.each([['enable', '启用'], ['disable', '停用'], ['remove', '删除']] as const)(
    'shows direct confirmation for %s with the page-level activation entry', (operation, label) => {
      const view: ExecutorManagementView = {
        baseRevisionId: 'revision-test', tools: [], executors: [{
          agentClassRef: 'pi-research', tool: 'pi', displayName: '分析师', enabled: false,
          operations: 'restricted', manualSourceText: '',
          modelPolicy: { mode: 'fixed', modelRef: 'default-model' },
        }],
      };
      const html = renderToStaticMarkup(createElement(ExecutorEditorDialog, {
        http: new HttpClient(), view, config: {}, agentClassRef: 'pi-research', operation, disabled: false,
        onClose: () => undefined, onSaved: () => undefined, onRemoved: () => undefined,
        onEnabled: () => undefined,
      }));
      expect(html).toContain(`确认${label}`);
      expect(html).toContain('保存并激活');
      expect(html).not.toContain('预览变更');
      expect(html).not.toContain('确认并热生效');
    },
  );
  it.each(['create', 'update'] as const)('%s has only a draft save, without preview or activation', operation => {
    const html = renderToStaticMarkup(createElement(ExecutorEditorDialog, {
      http: new HttpClient(), view: { baseRevisionId: 'base', tools: [], executors: [] },
      config: {}, operation, disabled: false, onClose: () => undefined, onSaved: () => undefined,
      onRemoved: () => undefined, onEnabled: () => undefined,
    }));
    expect(html).toContain('保存到当前设置草稿');
    expect(html).toMatch(/type="submit"[^>]*>保存<\/button>/u);
    expect(html).not.toContain('预览变更');
    expect(html).not.toContain('确认并热生效');
    expect(html).not.toContain('AI 改写预览');
    expect(html).not.toContain('允许的操作范围');
    expect(html).not.toContain('permissionProfileRef');
    expect(html).toContain('敏感操作由系统统一授权');
  });
});
