import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PlanningAgentPlanOutputSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMetaWorkContext } from '../../src/planning/manager-host/extension/context-tool.js';
import metaworkManager, { isInside, listWorkspace } from '../../src/planning/manager-host/extension/index.js';

// P2-B3: the Manager's Pi-side surface. The Manager may read the workspace and
// submit exactly one proposal; everything else is blocked in the extension so a
// prompt-level instruction is not the only thing standing between planning and
// executing.
function fakeApi() {
  const tools: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const activeTools: string[][] = [];
  return {
    tools,
    handlers,
    activeTools,
    api: {
      registerTool(tool: Record<string, unknown>) { tools.push(tool); },
      on(event: string, handler: (e: any, ctx?: any) => any) { handlers.set(event, handler); },
      setActiveTools(names: string[]) { activeTools.push(names); },
    },
  };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('manager pi extension', () => {
  it('rejects mutation methods before opening a context connection', async () => {
    await expect(readMetaWorkContext({ method: 'delete_memory', arguments: { id: 'memory' } }))
      .rejects.toThrow('manager_context_method_forbidden');
  });
  it('keeps context reads unavailable to permission judgments', async () => {
    vi.stubEnv('METAWORK_MANAGER_MCP_CONFIG', '/host-owned/config');
    vi.stubEnv('METAWORK_MANAGER_PURPOSE', 'permission');
    try {
      const { api, tools, handlers } = fakeApi();
      metaworkManager(api);
      expect(tools.map(tool => tool.name)).toEqual(['submit_manager_proposal']);
      expect(await handlers.get('tool_call')!({ toolName: 'read_metawork_context' })).toMatchObject({ block: true });
    } finally { vi.unstubAllEnvs(); }
  });
  it('rejects a missing configured schema instead of silently prompting with an empty contract', () => {
    const previous = process.env.METAWORK_MANAGER_PLAN_SCHEMA;
    process.env.METAWORK_MANAGER_PLAN_SCHEMA = '/missing-metawork-schema.json';
    try {
      expect(() => metaworkManager(fakeApi().api)).toThrow('manager_plan_schema_unavailable');
    } finally {
      if (previous === undefined) delete process.env.METAWORK_MANAGER_PLAN_SCHEMA;
      else process.env.METAWORK_MANAGER_PLAN_SCHEMA = previous;
    }
  });
  it('registers only the proposal tool as an output channel', () => {
    const { api, tools } = fakeApi();
    metaworkManager(api as any);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('submit_manager_proposal');
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['proposal'] });
    expect(String(tool.description)).toContain('exactly once');
  });

  it('returns the proposal as tool details so the host reads a structured value', async () => {
    const { api, tools } = fakeApi();
    metaworkManager(api as any);
    const execute = tools[0]!.execute as (id: string, params: any) => Promise<any>;
    const ok = await execute('call-1', { proposal: { schemaVersion: 9, subtasks: [] } });
    expect(ok).toMatchObject({ isError: false, details: { proposal: { schemaVersion: 9 } } });
    const empty = await execute('call-2', {});
    expect(empty).toMatchObject({ isError: true });
  });

  it('injects the Manager rules and restricts the active tools', async () => {
    const { api, handlers, activeTools } = fakeApi();
    const previousSchema = process.env.METAWORK_MANAGER_PLAN_SCHEMA;
    const root = mkdtempSync(join(tmpdir(), 'manager-schema-'));
    roots.push(root);
    const schemaPath = join(root, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(z.toJSONSchema(PlanningAgentPlanOutputSchema, { target: 'draft-7', unrepresentable: 'any' })));
    process.env.METAWORK_MANAGER_PLAN_SCHEMA = schemaPath;
    try {
      metaworkManager(api as any);
      const result = await handlers.get('before_agent_start')!({ cwd: '/tmp/ws', systemPrompt: 'base' }, {});
      expect(result.systemPrompt).toContain('# MetaWork Manager');
      expect(result.systemPrompt).toContain('Never edit, create or delete files');
      expect(result.systemPrompt).toContain('submit_manager_proposal');
      expect(result.systemPrompt).toContain('Canonical proposal JSON Schema:');
      expect(result.systemPrompt).toContain('clarificationQuestion');
      expect(result.systemPrompt).toContain('Nullable fields are still required');
      expect(result.systemPrompt).not.toContain('reason, response,');
      // The manager must plan deliverable work, not ask the user about its own tools.
      expect(result.systemPrompt).toContain('plan_work_graph with workspaceIntent.operation of create_in_target');
      expect(result.systemPrompt).toContain("Ask a clarification only when the USER'S intent is unclear");
      expect(result.systemPrompt).toContain('Never ask about your own tool permissions');
      expect(typeof result.systemPrompt).toBe('string');
      expect(activeTools[0]).toEqual(['read', 'ls', 'grep', 'find', 'submit_manager_proposal']);
    } finally {
      if (previousSchema === undefined) delete process.env.METAWORK_MANAGER_PLAN_SCHEMA;
      else process.env.METAWORK_MANAGER_PLAN_SCHEMA = previousSchema;
    }
  });

  it('blocks write tools and reads outside the workspace', async () => {
    const { api, handlers } = fakeApi();
    metaworkManager(api as any);
    const onToolCall = handlers.get('tool_call')!;
    expect(await onToolCall({ toolName: 'submit_manager_proposal' })).toBeUndefined();
    expect(await onToolCall({ toolName: 'read', input: { path: join(process.cwd(), 'package.json') } }))
      .toBeUndefined();
    expect(await onToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }))
      .toMatchObject({ block: true });
    expect(await onToolCall({ toolName: 'read', input: { path: '/etc/passwd' } }))
      .toMatchObject({ block: true });
  });

  it('keeps path containment honest', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-containment-'));
    roots.push(root);
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(root, 'workspace', 'safe.txt'), 'safe');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'workspace', 'escape.txt'));
    symlinkSync(join(root, 'workspace', 'safe.txt'), join(root, 'workspace', 'inside.txt'));
    symlinkSync(root, join(root, 'workspace', 'escape-dir'));
    const workspace = join(root, 'workspace');
    expect(isInside('safe.txt', workspace)).toBe(true);
    expect(isInside('inside.txt', workspace)).toBe(true);
    expect(isInside(workspace, workspace)).toBe(true);
    expect(isInside('escape.txt', workspace)).toBe(false);
    expect(isInside('escape-dir/secret.txt', workspace)).toBe(false);
    expect(isInside('../secret.txt', workspace)).toBe(false);
    expect(isInside('missing.txt', workspace)).toBe(false);
    expect(isInside('/etc/passwd', workspace)).toBe(false);
  });

  it('lists the workspace without node_modules or .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-ext-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
    const entries = listWorkspace(root);
    expect(entries).toContain('src/');
    expect(entries).toContain(join('src', 'index.ts'));
    expect(entries).toContain('README.md');
    expect(entries.some(entry => entry.startsWith('node_modules'))).toBe(false);
  });
});
