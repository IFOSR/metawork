import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('server-composition.ts',
  await readFile(new URL('../../src/server/server-composition.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function productionCallback(name: string, scope: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  let callback: ts.ArrowFunction | undefined;
  function collect(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name
      && ts.isArrowFunction(node.initializer)) callback = node.initializer;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(source) === name && ts.isArrowFunction(node.right)) callback = node.right;
    ts.forEachChild(node, collect);
  }
  collect(source);
  if (!callback) throw new Error(`Production callback missing: ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(scope), `${outputText}\nreturn callback;`)(...Object.values(scope));
}

describe('production Workspace binding read paths', () => {
  it.each([true, false])('publishes row activity using metadata only (bound=%s)', async bound => {
    const activity = { state: 'executing', taskId: 'task_one', updatedAt: '2026-09-26T00:00:00Z' };
    const readConversation = vi.fn(() => { throw new Error('must not hydrate history for activity'); });
    const readMetadata = vi.fn(async () => ({
      workspaceBinding: bound ? { workspaceId: 'ws_one' } : null,
    }));
    const observeActivity = vi.fn();
    const publishActivity = vi.fn();
    const publish = productionCallback('publishWorkspaceActivity', {
      conversationStore: { readMetadata, readConversation },
      directoryProjector: { observeActivity },
      workspaceGatewayRuntime: { publishActivity },
    });
    await publish('conv_one', activity);
    expect(readMetadata.mock.calls).toEqual([['conv_one']]);
    expect(readConversation).not.toHaveBeenCalled();
    expect(observeActivity.mock.calls).toEqual([['conv_one', activity]]);
    if (bound) {
      expect(publishActivity.mock.calls).toEqual([['ws_one', { conversationId: 'conv_one', activity }]]);
    } else {
      expect(publishActivity).not.toHaveBeenCalled();
    }
  });

  it('resolves the user Workspace without hydrating Conversation history', async () => {
    const readMetadata = vi.fn(async () => ({ workspaceBinding: { workspaceId: 'ws_one' } }));
    const readConversation = vi.fn(() => { throw new Error('must not hydrate history for Workspace binding'); });
    const findById = vi.fn(async () => ({ canonicalPath: '/workspace' }));
    const resolveRoot = productionCallback('resolveUserWorkspaceRoot', {
      conversationStore: { readMetadata, readConversation },
      workspaceCatalogStore: { findById },
    });
    expect(await resolveRoot('conv_one')).toBe('/workspace');
    expect(readMetadata.mock.calls).toEqual([['conv_one']]);
    expect(findById.mock.calls).toEqual([['ws_one']]);
    expect(readConversation).not.toHaveBeenCalled();
  });
});
