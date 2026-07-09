// Process-based LLM adapter plus legacy semantic prompt schemas used by older routing paths.
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import type { MemoryApplicabilityAction, TaskStatus } from './types.js';
import { buildCodexNonInteractiveArgs } from '../executor/codex-args.js';

export interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  summary: string;
  status: TaskStatus;
  lastInterruptionReason: string;
  nextStep: string;
  blockedReason: string | null;
}

export interface InteractionSummary {
  id: string;
  userInput: string;
}

/**
 * Parked/blocked resume-intent observation. Consumed only via TaskSemanticService
 * as an adapter boundary; the session must not call this directly.
 */
export interface TaskResumeIntentResult {
  action: 'resume' | 'none';
  taskId: string | null;
  reason: string;
  confidence: number;
}

export interface TaskPriorityResult {
  priority: 'normal' | 'high' | 'urgent';
  reason: string;
}

export interface PreferenceRecallSummary {
  id: string;
  scope: string;
  subject: string | null;
  type: string;
  content: string;
}

export interface PreferenceRecallDecision {
  preferenceId: string;
  reason: string;
  score?: number;
  action?: MemoryApplicabilityAction;
}

const LLM_TIMEOUT = 30_000;
type SpawnFn = typeof spawn;

interface LlmBridgeDeps {
  spawn?: SpawnFn;
  cwd?: () => string;
}

export class LlmBridge {
  constructor(
    private command: string,
    private readonly deps: LlmBridgeDeps = {},
  ) {}

  async query(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const cwd = this.deps.cwd?.() ?? tmpdir();
      const proc = (this.deps.spawn ?? spawn)(this.command, this.buildCommandArgs(prompt), {
        cwd,
        timeout: LLM_TIMEOUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(
          `LLM command "${this.command}" exited with code ${code ?? 'unknown'} in ${cwd}. `
          + `stderr: ${summarizeProcessText(stderr) || '(empty)'}`,
        ));
      });
      proc.on('error', reject);
    });
  }

  private buildCommandArgs(prompt: string): string[] {
    if (this.command === 'codex') {
      return buildCodexNonInteractiveArgs(prompt);
    }

    if (this.command === 'pi') {
      // Pi rejects Claude-only flags such as --dangerously-skip-permissions.
      // Reasoning calls only need plain text output: no tools, no session, no
      // extension/context-file discovery. The provider/model resolve from
      // pi's settings.json (see docker/pi-config).
      return [
        '--no-tools',
        '--no-session',
        '--no-extensions',
        '--no-context-files',
        '-p',
        prompt,
      ];
    }

    return [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];
  }

  /**
   * Parked/blocked resume-intent observation. Consumed only via TaskSemanticService
   * as an adapter boundary; the session must not call this directly.
   */
  async resolveTaskResumeIntent(userInput: string, candidateTasks: TaskSummary[]): Promise<TaskResumeIntentResult> {
    const resumableTasks = candidateTasks.filter(task => task.status === 'parked' || task.status === 'blocked');
    if (resumableTasks.length === 0) {
      return { action: 'none', taskId: null, reason: '没有 blocked/parked 候选任务', confidence: 0 };
    }

    try {
      return this.normalizeTaskResumeIntentResult(
        this.parseTaskResumeIntentResult(await this.query(this.buildTaskResumeIntentPrompt(userInput, resumableTasks))),
        resumableTasks,
      );
    } catch {
      return { action: 'none', taskId: null, reason: 'LLM resume intent 调用失败，fallback', confidence: 0 };
    }
  }

  async resolveTaskPriority(userInput: string): Promise<TaskPriorityResult> {
    try {
      const raw = await this.query(this.buildTaskPriorityPrompt(userInput));
      return this.parseTaskPriorityResult(raw);
    } catch {
      return this.fallbackTaskPriorityResult(userInput);
    }
  }

  async rankInteractions(userInput: string, candidates: InteractionSummary[]): Promise<string[]> {
    if (candidates.length === 0) return [];

    try {
      const prompt = this.buildRankPrompt(userInput, candidates);
      const raw = await this.query(prompt);
      return this.parseRankResult(raw);
    } catch {
      return [];
    }
  }

  async recallPreferences(
    userInput: string,
    candidates: PreferenceRecallSummary[],
  ): Promise<PreferenceRecallDecision[]> {
    if (candidates.length === 0) return [];

    try {
      const prompt = this.buildPreferenceRecallPrompt(userInput, candidates);
      const raw = await this.query(prompt);
      return this.parsePreferenceRecallResult(raw, new Set(candidates.map(candidate => candidate.id)));
    } catch {
      throw new Error('LLM preference recall 调用失败');
    }
  }

  private buildTaskResumeIntentPrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.map(task =>
      `  ${task.id}: [${task.status}] ${task.title} / ${task.goal}${task.summary ? ` / 进度: ${task.summary.slice(0, 80)}` : ''}`
    ).join('\n');

    return [
      '判断用户输入是否是在要求恢复、重启、继续执行下面某个已经 blocked 或 parked 的任务。',
      '这是语义判断，不要只看关键词；要理解用户真实意图。',
      '只有当用户明显是在操作已有任务，而不是提出一个全新工作目标时，才返回 action=resume。',
      '如果用户指定了 task id，且该 id 在候选列表中，通常应选择该任务。',
      '如果用户只是提出新的调研/分析/实现需求，即使文字里出现“任务”，也返回 action=none。',
      '如果多个候选都可能匹配，选择语义最贴近用户输入、状态为 blocked/parked、最近上下文最连续的那个。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '候选 blocked/parked 任务：',
      taskList,
      '',
      '返回格式：{"action":"resume"|"none","taskId":"task_xxx"|null,"confidence":0到1,"reason":"简短原因"}',
    ].join('\n');
  }

  private buildTaskPriorityPrompt(userInput: string): string {
    return [
      '判断这个任务的调度优先级。必须做语义判断，不要只看关键词。',
      'urgent: 用户语义上是在插队、临时紧急处理、要求打断当前队列、马上/立即处理，或任务本身有明显时间压力。',
      'high: 比普通任务更重要或更希望优先，但不一定要插队打断。',
      'normal: 顺序执行即可，没有紧急或优先语义。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '返回格式：{"priority":"normal"|"high"|"urgent","reason":"简短语义依据"}',
    ].join('\n');
  }

  private buildRankPrompt(userInput: string, candidates: InteractionSummary[]): string {
    const list = candidates.map(c =>
      `  ${c.id}: ${c.userInput.slice(0, 50)}`
    ).join('\n');

    return [
      '从以下历史交互中，选出与用户当前输入最相关的条目。',
      '只返回相关条目的 ID 数组（JSON），最多 5 个。如果都不相关，返回空数组 []。',
      '',
      `用户输入：${userInput}`,
      '',
      '历史交互：',
      list,
      '',
      '返回格式：["id_1", "id_2"]',
    ].join('\n');
  }

  private buildPreferenceRecallPrompt(
    userInput: string,
    candidates: PreferenceRecallSummary[],
  ): string {
    const list = candidates.map(candidate => [
      `  ${candidate.id}:`,
      `    scope=${candidate.scope}`,
      `    subject=${candidate.subject ?? 'null'}`,
      `    type=${candidate.type}`,
      `    content=${candidate.content}`,
    ].join('\n')).join('\n');

    return [
      '判断用户当前输入是否需要召回下面的用户偏好/记忆。',
      '这是产品体验关键路径：必须理解用户意图和偏好的适用边界，不要做关键词匹配。',
      '请对每条候选做三态裁决：auto_apply / ask_review / suppress。',
      'auto_apply: 明确相关、低风险、没有当前指令冲突，可静默采用。',
      'ask_review: 中等相关、不确定、可能改变执行路径或存在高影响；系统会默认跳过，不会询问用户确认。',
      'suppress: 只有关键词相同、泛词命中、元讨论、纠错/否认、无关场景，静默忽略。',
      '只有当偏好对当前请求的执行方式、输出格式、对象关系或上下文选择有明确帮助时才 auto_apply 或 ask_review。',
      '不要因为共享“内容、分析、相关、报告、图片、文档”等泛词就召回。',
      '如果用户当前输入是在否认、纠错、询问系统行为，通常不要召回交付物偏好。',
      'task-local 且属于当前任务的偏好通常可以召回；project/contact/global 需要语义相关。',
      '只返回 JSON 数组，不要其他内容。每项必须包含 preferenceId、action、reason、score。',
      '',
      `用户输入：${userInput}`,
      '',
      '候选偏好：',
      list,
      '',
      '返回格式：[{"preferenceId":"pref_xxx","action":"auto_apply|ask_review|suppress","reason":"为什么这样裁决","score":0.0到1.0}]',
      '如果都完全不适用，可以返回 suppress 项，也可以返回 []。',
    ].join('\n');
  }

  private parseTaskResumeIntentResult(raw: string): TaskResumeIntentResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
      if (parsed.action === 'resume') {
        return {
          action: 'resume',
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义判断恢复已有任务',
          confidence,
        };
      }
      if (parsed.action === 'none') {
        return {
          action: 'none',
          taskId: null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义判断不是恢复任务',
          confidence,
        };
      }
    } catch {}

    return { action: 'none', taskId: null, reason: 'resume intent 解析失败，fallback', confidence: 0 };
  }

  private parseRankResult(raw: string): string[] {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {}
    return [];
  }

  private parsePreferenceRecallResult(raw: string, validIds: Set<string>): PreferenceRecallDecision[] {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((item): PreferenceRecallDecision | null => {
          const preferenceId = typeof item?.preferenceId === 'string'
            ? item.preferenceId
            : typeof item?.id === 'string'
              ? item.id
              : null;
          if (!preferenceId || !validIds.has(preferenceId)) {
            return null;
          }

          const rawScore = typeof item?.score === 'number' ? item.score : undefined;
          const score = rawScore === undefined
            ? undefined
            : Math.max(0, Math.min(1, rawScore));

          return {
            preferenceId,
            reason: typeof item?.reason === 'string' && item.reason.trim()
              ? item.reason.trim()
              : 'executor 判定当前偏好适用',
            score,
            action: this.parsePreferenceRecallAction(item?.action),
          };
        })
        .filter((item): item is PreferenceRecallDecision => Boolean(item));
    } catch {}

    return [];
  }

  private parsePreferenceRecallAction(value: unknown): MemoryApplicabilityAction | undefined {
    return value === 'auto_apply' || value === 'ask_review' || value === 'suppress'
      ? value
      : undefined;
  }

  private parseTaskPriorityResult(raw: string): TaskPriorityResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.priority === 'normal' || parsed.priority === 'high' || parsed.priority === 'urgent') {
        return {
          priority: parsed.priority,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义优先级判断',
        };
      }
    } catch {}

    return { priority: 'normal', reason: 'priority 解析失败，fallback normal' };
  }

  private fallbackTaskPriorityResult(userInput: string): TaskPriorityResult {
    if (/紧急|急|插入|插队|优先|马上|立刻|立即|urgent|asap/i.test(userInput)) {
      return { priority: 'urgent', reason: 'LLM 不可用，规则兜底识别到紧急/插队表达' };
    }
    return { priority: 'normal', reason: 'LLM 不可用，未识别到明确优先级信号' };
  }

  private normalizeTaskResumeIntentResult(
    result: TaskResumeIntentResult,
    candidates: TaskSummary[],
  ): TaskResumeIntentResult {
    if (result.action !== 'resume' || !result.taskId) {
      return { ...result, action: 'none', taskId: null };
    }

    return candidates.some(task => task.id === result.taskId)
      ? result
      : { action: 'none', taskId: null, reason: 'LLM 返回了无效恢复任务 ID，fallback', confidence: 0 };
  }
}

function summarizeProcessText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}
