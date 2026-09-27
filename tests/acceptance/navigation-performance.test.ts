import { describe, expect, it, vi } from 'vitest';
import { createNavigationPerformanceFixture } from '../fixtures/navigation-performance-server.js';
import { WebSocket } from 'ws';

describe('production-shaped navigation HTTP acceptance', () => {
  it('selects, pages, attaches and creates without directory replay or catalog scans', async () => {
    const fixture = await createNavigationPerformanceFixture();
    try {
      const origin = fixture.server.address;
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ username: 'admin', password: 'test-password' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const request = async (path: string, body?: unknown) => {
        const start = performance.now();
        const response = await fetch(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = await response.json();
        expect(response.status).toBeLessThan(300);
        return { result, milliseconds: performance.now() - start };
      };
      const readCatalog = vi.spyOn(fixture.conversations, 'readCatalog');
      const replay = vi.spyOn(fixture.journal, 'replay');
      const pageQuery = vi.spyOn(fixture.projection, 'page');
      const admissionCount = () => (fixture.db.prepare(
        'SELECT count(*) AS count FROM gateway_command_admissions',
      ).get() as { count: number }).count;
      expect(admissionCount()).toBe(3000);
      const timings: { action: string; milliseconds: number }[] = [];
      for (const workspace of fixture.workspaces) {
        pageQuery.mockClear();
        const selection = await request('/api/workspaces/select', { path: workspace.canonicalPath });
        expect(selection.result.activeWorkspaceId).toBe(workspace.id);
        expect(selection.result.selection.conversations.length).toBeLessThanOrEqual(50);
        expect(pageQuery).toHaveBeenCalledTimes(1);
        timings.push({ action: 'select', milliseconds: selection.milliseconds });
      }
      expect(admissionCount()).toBe(3003);
      expect(readCatalog).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      const workspace = fixture.workspaces.at(-1)!;
      const first = await request(`/api/workspaces/${workspace.id}/conversations`);
      const second = await request(`/api/workspaces/${workspace.id}/conversations?cursor=${encodeURIComponent(first.result.nextCursor)}`);
      expect(first.result.conversations).toHaveLength(50);
      expect(second.result.conversations).toHaveLength(50);
      expect(new Set([...first.result.conversations, ...second.result.conversations].map(item => item.id)).size).toBe(100);
      expect(readCatalog).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      const id = first.result.conversations[0].id;
      pageQuery.mockClear();
      const wrongWorkspace = fixture.workspaces[0]!.id;
      const rejected = await request(`/api/conversations/${id}/attach?workspaceId=${wrongWorkspace}`, {});
      expect(rejected.result).toEqual({
        state: 'activation_blocked', sessionId: id, reason: 'session_unavailable',
      });
      expect((await fetch(`${origin}/api/conversations/${id}`, { headers: { cookie, origin } })).status).toBe(404);
      const attach = await request(`/api/conversations/${id}/attach?workspaceId=${workspace.id}`, {});
      expect(attach.result.state).toBe('active');
      expect(pageQuery).not.toHaveBeenCalled();
      const history = await request(`/api/conversations/${id}`);
      expect(history.result.turns[0].finalAnswer).toBe('Conclusion for Workspace 3');
      replay.mockClear();
      const largeAttach = await request('/api/conversations/conv_2_001/attach', {});
      const readAggregate = vi.spyOn(fixture.conversations, 'readConversation');
      const largeFirst = await request('/api/conversations/conv_2_001');
      expect(largeFirst.result.turns).toHaveLength(10);
      expect(largeFirst.result.turns.at(-1).id).toBe('large_turn_44');
      const ids = largeFirst.result.turns.map((turn: { id: string }) => turn.id);
      let cursor = largeFirst.result.historyCursor;
      while (cursor) {
        const older = await request(`/api/conversations/conv_2_001?cursor=${encodeURIComponent(cursor)}`);
        expect(older.result.turns.length).toBeLessThanOrEqual(10);
        ids.push(...older.result.turns.map((turn: { id: string }) => turn.id));
        cursor = older.result.historyCursor;
      }
      expect(ids).toHaveLength(45);
      expect(new Set(ids).size).toBe(45);
      expect(readAggregate).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      timings.push({ action: 'large_attach_cold', milliseconds: largeAttach.milliseconds },
        { action: 'large_history_first', milliseconds: largeFirst.milliseconds });
      const creationStages: { stage: string; milliseconds: number }[] = [];
      const writeCatalog = fixture.conversations.writeCatalog.bind(fixture.conversations);
      vi.spyOn(fixture.conversations, 'writeCatalog').mockImplementation(async value => {
        const start = performance.now();
        try { await writeCatalog(value); }
        finally { creationStages.push({ stage: 'catalog_write', milliseconds: performance.now() - start }); }
      });
      const writeConversation = fixture.conversations.writeConversation.bind(fixture.conversations);
      vi.spyOn(fixture.conversations, 'writeConversation').mockImplementation(async value => {
        const start = performance.now();
        try { await writeConversation(value); }
        finally { creationStages.push({ stage: 'conversation_write', milliseconds: performance.now() - start }); }
      });
      const append = fixture.journal.append.bind(fixture.journal);
      vi.spyOn(fixture.journal, 'append').mockImplementation(async event => {
        const start = performance.now();
        try { return await append(event); }
        finally { creationStages.push({ stage: 'journal_append', milliseconds: performance.now() - start }); }
      });
      const created = await request(`/api/workspaces/${workspace.id}/conversations`, {});
      expect(created.result.activation.state).toBe('active');
      expect(created.result.session.turns).toEqual([]);
      expect(pageQuery).not.toHaveBeenCalled();
      console.info('navigation-create-stages', JSON.stringify(creationStages));
      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, {
        headers: { cookie, origin },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        const changed = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('workspace row event not received')), 2_000);
          socket.on('message', data => {
            const event = JSON.parse(String(data));
            if (event.type === 'workspace_conversation_changed' && event.conversationId === id) {
              clearTimeout(timer);
              resolve(event);
            }
          });
        });
        await fixture.changeActivity(id, { state: 'planning', taskId: null, updatedAt: new Date().toISOString() });
        expect(await changed).toMatchObject({
          workspaceId: workspace.id, conversationId: id, changes: { activity: { state: 'planning' } },
        });
        expect(pageQuery).not.toHaveBeenCalled();
      } finally { socket.close(); }
      timings.push({ action: 'directory', milliseconds: first.milliseconds },
        { action: 'attach', milliseconds: attach.milliseconds },
        { action: 'history', milliseconds: history.milliseconds },
        { action: 'create', milliseconds: created.milliseconds });
      console.info('navigation-fixture-timings', JSON.stringify(timings));
      // Generous CI guard; the stricter p95 budgets require live repeated samples.
      expect(timings.every(item => item.milliseconds < 1000)).toBe(true);
    } finally { await fixture.close(); }
  }, 30_000);
});
