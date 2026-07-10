// Shared structural session helpers for execution requests, inline resources,
// editor submission, and preference capture.
import type { TaskRecoveryTrigger } from '../core/types.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
export { planTaskExecution, type TaskExecutionPlan as ExecutionPlan } from '../task/task-execution-planner.js';
export {
  extractInlineResourceMatches,
  stripInlineResourceMatches,
  type InlineResourceMatch,
} from '../intent/inline-resource-normalizer.js';

export type QueuedExecutionRequest = {
  userPrompt: string;
  contextTaskId: string;
  executionMode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  planningPlan?: PlanningAgentPlan | null;
  kernelDecisionId?: string | null;
  origin?: 'user' | 'system';
  schedulingReason?: string;
  newlyProvidedResources?: string[];
  recoveryTrigger?: TaskRecoveryTrigger;
  includeRecentConversationContext?: boolean;
};

export function extractPatterns(input: string): string[] {
  const patterns: string[] = [];

  const styleMatch = input.match(/用(.{2,10})(格式|语气|方式|风格)/);
  if (styleMatch) patterns.push(`用${styleMatch[1]}${styleMatch[2]}`);

  const ccMatch = input.match(/抄送(.{2,10})/);
  if (ccMatch) patterns.push(`抄送${ccMatch[1]}`);

  return patterns;
}

export function extractHighConfidencePreferenceCandidates(input: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: string | undefined) => {
    const cleaned = cleanPreferenceCandidate(candidate);
    if (!cleaned || seen.has(cleaned)) {
      return;
    }
    seen.add(cleaned);
    candidates.push(cleaned);
  };

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const explicitBoldPreference = line.match(/(?:你|我)?明确偏好[：:]\s*\*\*(.+?)\*\*/);
    pushCandidate(explicitBoldPreference?.[1]);

    const reusableBoldRule = line.match(/(?:可复用的工作规则|固定成一条可复用的工作规则|工作规则)[：:]\s*\*\*(.+?)\*\*/);
    pushCandidate(reusableBoldRule?.[1]);

    const explicitPreference = line.match(/^(?:我)?(?:明确)?偏好[：:]\s*(.+)$/);
    pushCandidate(explicitPreference?.[1]);

    const futureRule = line.match(/^(?:以后|之后|后续|接下来)[，,。.\s]*(凡是.+)$/);
    pushCandidate(futureRule?.[1]);

    const defaultRule = line.match(/^(凡是.+(?:默认|应该|需要|必须).+)$/);
    pushCandidate(defaultRule?.[1]);

    const preferenceRule = line.match(/^(我(?:更喜欢|比较喜欢|希望|倾向于).+)$/);
    pushCandidate(preferenceRule?.[1]);
  }

  return candidates;
}

function cleanPreferenceCandidate(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }

  const cleaned = candidate
    .replace(/\*\*/g, '')
    .replace(/^["“”'「」]+|["“”'「」]+$/g, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();

  if (cleaned.length < 8) {
    return null;
  }

  return cleaned;
}

export function isHighRiskMemoryCandidate(input: string): boolean {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }

  return /(自动)?(发给客户|发给用户|发给对方|发送给客户|发送给用户|发送给对方|对外发送|外发|群发|发出去|提交给法务|提交给财务|删除|清空|覆盖|生产环境|线上|prod|财务承诺|法律承诺|合同承诺)/i.test(normalized);
}

export function prepareEditorSubmission(editor: { text: string; cursor: number }): {
  userInput: string;
  nextEditor: { text: string; cursor: number };
} {
  return {
    userInput: editor.text.trim(),
    nextEditor: { text: '', cursor: 0 },
  };
}

