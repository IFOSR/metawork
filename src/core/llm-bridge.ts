// Generic process-based LLM adapter for memory recall and interaction ranking.
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { z } from 'zod';
import type { MemoryApplicabilityAction, TaskStatus } from './types.js';
import { extractJsonObject } from './llm-json.js';
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

  private parseRankResult(raw: string): string[] {
    try {
      return RankSchema.parse(extractJsonObject(raw));
    } catch {}
    return [];
  }

  private parsePreferenceRecallResult(raw: string, validIds: Set<string>): PreferenceRecallDecision[] {
    try {
      return PreferenceRecallArraySchema
        .parse(extractJsonObject(raw))
        .filter((item): item is PreferenceRecallDecision => (
          item !== null && validIds.has(item.preferenceId)
        ));
    } catch {}

    return [];
  }

}

const ClampedScore = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(1, numeric));
}, z.number().optional());

const RankSchema = z.preprocess(
  value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  z.array(z.string()),
);

const PreferenceRecallReasonSchema = z.preprocess(
  value => typeof value === 'string' && value.trim() ? value.trim() : 'executor 判定当前偏好适用',
  z.string(),
);

const PreferenceRecallActionSchema = z
  .enum(['auto_apply', 'ask_review', 'suppress'])
  .optional()
  .catch(undefined);

const PreferenceRecallItemSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  return {
    ...item,
    preferenceId: typeof item.preferenceId === 'string' ? item.preferenceId : item.id,
  };
}, z.object({
  preferenceId: z.string(),
  reason: PreferenceRecallReasonSchema,
  score: ClampedScore,
  action: PreferenceRecallActionSchema,
}));

const PreferenceRecallArraySchema = z.preprocess(
  value => Array.isArray(value) ? value : [],
  z.array(PreferenceRecallItemSchema.nullable().catch(null)),
);

function summarizeProcessText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}
