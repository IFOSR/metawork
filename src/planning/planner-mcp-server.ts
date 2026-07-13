import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'path';
import { truncateText } from '../utils/truncate-text.js';

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 10;
const TASK_STATUSES = ['created', 'ready', 'running', 'parked', 'blocked', 'done', 'archived', 'cancelled'] as const;

export class PlannerDataReader {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
  ) {}

  searchTasks(input: { query?: string; statuses?: string[]; limit?: number }) {
    const limit = boundedLimit(input.limit);
    const statuses = (input.statuses ?? []).filter(status => TASK_STATUSES.includes(status as typeof TASK_STATUSES[number]));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.query?.trim()) {
      clauses.push("LOWER(title || ' ' || COALESCE(goal, '') || ' ' || COALESCE(summary, '')) LIKE ?");
      params.push(`%${input.query.trim().toLowerCase()}%`);
    }
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT id, title, status, summary, priority_json, updated_at
      FROM tasks
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
    return {
      count: rows.length,
      tasks: rows.map(row => ({
        id: row.id,
        title: truncateText(String(row.title ?? ''), 160),
        status: row.status,
        summary: truncateText(String(row.summary ?? ''), 320),
        priority: sanitizePriority(row.priority_json),
        updatedAt: row.updated_at,
      })),
    };
  }

  getTaskContext(taskId: string) {
    const row = this.db.prepare(`
      SELECT id, title, goal, status, summary, snapshot_json, resources_json,
             artifacts_json, dependencies_json, priority_json,
             last_scheduling_reason, last_interruption_reason, interruption_count,
             created_at, updated_at
      FROM tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return { found: false, taskId };
    const snapshots = safeJson<Array<Record<string, unknown>>>(row.snapshot_json, []);
    const dependencies = safeJson<Array<Record<string, unknown>>>(row.dependencies_json, []);
    const latest = snapshots.at(-1) ?? null;
    return {
      found: true,
      task: {
        id: row.id,
        title: truncateText(String(row.title ?? ''), 200),
        goal: truncateText(String(row.goal ?? ''), 800),
        status: row.status,
        summary: truncateText(String(row.summary ?? ''), 800),
        priority: sanitizePriority(row.priority_json),
        latestSnapshot: latest ? sanitizeSnapshot(latest) : null,
        blockers: dependencies
          .filter(item => item.status === 'waiting')
          .slice(0, MAX_RESULTS)
          .map(item => ({ taskId: item.taskId, description: truncateText(String(item.description ?? ''), 320) })),
        resources: safeJson<unknown[]>(row.resources_json, []).slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)),
        artifacts: safeJson<unknown[]>(row.artifacts_json, []).slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)),
        lastSchedulingReason: truncateText(String(row.last_scheduling_reason ?? ''), 320),
        lastInterruptionReason: truncateText(String(row.last_interruption_reason ?? ''), 320),
        interruptionCount: row.interruption_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }

  getCurrentSessionContext(limit?: number) {
    const bounded = boundedLimit(limit);
    const interactions = this.db.prepare(`
      SELECT task_id, user_input, system_output, executor_used, created_at
      FROM interactions WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(this.sessionId, bounded) as Array<Record<string, unknown>>;
    const decisions = this.db.prepare(`
      SELECT id, task_id, plan_json, outcome, reason, created_at
      FROM planning_decisions WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(this.sessionId, Math.min(5, bounded)) as Array<Record<string, unknown>>;
    return {
      sessionId: this.sessionId,
      interactions: interactions.reverse().map(row => ({
        taskId: row.task_id,
        userInput: truncateText(String(row.user_input ?? ''), 500),
        systemOutput: truncateText(String(row.system_output ?? ''), 500),
        executorUsed: row.executor_used,
        createdAt: row.created_at,
      })),
      recentPlanningDecisions: decisions.reverse().map((row) => {
        const plan = safeJson<Record<string, unknown>>(row.plan_json, {});
        const task = isRecord(plan.task) ? plan.task : {};
        const risk = isRecord(plan.risk) ? plan.risk : {};
        return {
          id: row.id,
          taskId: row.task_id,
          action: plan.action,
          control: task.control,
          targetTaskId: task.taskId,
          outcome: row.outcome,
          riskRequiresConfirmation: risk.requiresConfirmation === true,
          reason: truncateText(String(row.reason ?? ''), 320),
          createdAt: row.created_at,
        };
      }),
    };
  }

  getRuntimeState() {
    const focus = this.db.prepare('SELECT * FROM session_state WHERE id = ?').get('global') as Record<string, unknown> | undefined;
    const taskCounts = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as Array<Record<string, unknown>>;
    const activeTasks = this.db.prepare(`
      SELECT id, title, status, updated_at FROM tasks
      WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked')
      ORDER BY updated_at DESC LIMIT ?
    `).all(MAX_RESULTS) as Array<Record<string, unknown>>;
    return {
      focus: focus ? {
        taskId: focus.last_focused_task_id,
        lastCompletedTaskId: focus.last_completed_task_id,
        updatedAt: focus.updated_at,
      } : null,
      taskCounts: Object.fromEntries(taskCounts.map(row => [String(row.status), Number(row.count)])),
      activeTasks: activeTasks.map(row => ({
        id: row.id,
        title: truncateText(String(row.title ?? ''), 160),
        status: row.status,
        updatedAt: row.updated_at,
      })),
    };
  }

  listExecutorClasses() {
    const classes = this.db.prepare(`
      SELECT name, domains_json, capabilities_json, input_types_json, output_types_json,
             strengths_json, weaknesses_json, primary_use_cases_json, avoid_use_cases_json,
             risk_level, harness, model, skills_json, mcp_servers_json, plugins_json,
             runtime_command IS NOT NULL AND runtime_command <> '' AS runtime_configured,
             runtime_check_command IS NOT NULL AS runtime_check_configured
      FROM agent_classes WHERE kind = 'executor' ORDER BY name ASC
    `).all() as Array<Record<string, unknown>>;
    const units = this.db.prepare(`
      SELECT agent_class_name, state, COUNT(*) AS count
      FROM work_units WHERE agent_class_kind = 'executor'
      GROUP BY agent_class_name, state
    `).all() as Array<Record<string, unknown>>;
    const capacity = new Map<string, Record<string, number>>();
    for (const row of units) {
      const states = capacity.get(String(row.agent_class_name)) ?? {};
      states[String(row.state)] = Number(row.count);
      capacity.set(String(row.agent_class_name), states);
    }
    return {
      count: classes.length,
      executorClasses: classes.map(row => ({
        name: row.name,
        domains: safeJson(row.domains_json, []),
        capabilities: safeJson(row.capabilities_json, []),
        inputTypes: safeJson(row.input_types_json, []),
        outputTypes: safeJson(row.output_types_json, []),
        strengths: safeJson(row.strengths_json, []),
        weaknesses: safeJson(row.weaknesses_json, []),
        primaryUseCases: safeJson(row.primary_use_cases_json, []),
        avoidUseCases: safeJson(row.avoid_use_cases_json, []),
        riskLevel: row.risk_level,
        harness: row.harness,
        model: row.model,
        skills: safeJson(row.skills_json, []),
        mcpServers: safeJson(row.mcp_servers_json, []),
        plugins: safeJson(row.plugins_json, []),
        runtimeConfigured: Boolean(row.runtime_configured),
        runtimeCheckConfigured: Boolean(row.runtime_check_configured),
        runtimeCapacity: capacity.get(String(row.name)) ?? {},
      })),
    };
  }
}

export function createPlannerMcpServer(reader: PlannerDataReader): McpServer {
  const server = new McpServer({ name: 'metaclaw-planner', version: '1.0.0' });
  server.registerTool('search_tasks', {
    description: 'Search persisted MetaClaw tasks by text and status. All persisted tasks are durable.',
    inputSchema: {
      query: z.string().max(500).optional(),
      statuses: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length).optional(),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    },
  }, async input => toolResult(reader.searchTasks(input)));
  server.registerTool('get_task_context', {
    description: 'Read one task status, snapshot, blockers, resources, completed items, pending items, and next step.',
    inputSchema: { taskId: z.string().min(1).max(160) },
  }, async input => toolResult(reader.getTaskContext(input.taskId)));
  server.registerTool('get_current_session_context', {
    description: 'Read bounded recent interactions and planning decisions for the current trusted session only.',
    inputSchema: { limit: z.number().int().min(1).max(MAX_RESULTS).optional() },
  }, async input => toolResult(reader.getCurrentSessionContext(input.limit)));
  server.registerTool('get_runtime_state', {
    description: 'Read current task focus and active task state without changing runtime state.',
    inputSchema: {},
  }, async () => toolResult(reader.getRuntimeState()));
  server.registerTool('list_executor_classes', {
    description: 'List static executor AgentClass capabilities plus aggregated live WorkUnit capacity.',
    inputSchema: {},
  }, async () => toolResult(reader.listExecutorClasses()));
  return server;
}

export async function runPlannerMcpServer(): Promise<void> {
  const home = process.env.METACLAW_HOME;
  const sessionId = process.env.METACLAW_PLANNER_SESSION_ID;
  if (!home) throw new Error('METACLAW_HOME is required');
  if (!sessionId) throw new Error('METACLAW_PLANNER_SESSION_ID is required');
  const dbPath = process.env.METACLAW_DB_PATH ?? join(home, 'metaclaw.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const server = createPlannerMcpServer(new PlannerDataReader(db, sessionId));
  await server.connect(new StdioServerTransport());
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function boundedLimit(limit?: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, limit ?? DEFAULT_RESULTS));
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sanitizeSnapshot(snapshot: Record<string, unknown>) {
  return {
    done: Array.isArray(snapshot.done) ? snapshot.done.slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)) : [],
    pending: Array.isArray(snapshot.pending) ? snapshot.pending.slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)) : [],
    nextStep: truncateText(String(snapshot.nextStep ?? ''), 500),
    pauseReason: truncateText(String(snapshot.pauseReason ?? ''), 500),
    createdAt: snapshot.createdAt,
  };
}

function sanitizePriority(value: unknown): Record<string, unknown> {
  const parsed = safeJson<unknown>(value, {});
  const priority = isRecord(parsed) ? parsed : {};
  if (typeof priority.semanticPriorityReason !== 'string') return priority;
  return {
    ...priority,
    semanticPriorityReason: truncateText(priority.semanticPriorityReason, 320),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
