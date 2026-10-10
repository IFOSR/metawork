import { z } from 'zod';
import { InternalLlmService, type InternalLlmDependencies } from './internal-llm-service.js';
import type { OpenRouterPublicFacts } from './openrouter-model-catalog.js';
import type { ModelRoutingNotes } from './types.js';

export interface SafeModelFact {
  modelRef: string;
  modelId: string;
  capabilities: readonly string[];
  description?: string;
  routingNotes?: ModelRoutingNotes;
  contextLimit?: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  /** Safe, public model facts used to tailor the task scope. */
  publicFacts?: OpenRouterPublicFacts;
}

export interface ResponsibilitySuggestion {
  sourceText: string;
  suggestedText: string;
  selectedModelRefs: string[];
  evidence: string[];
  requiresConfirmation: true;
}

export interface CapabilityCompilation {
  agentClassRef: string;
  modelRefs: string[];
  capabilities: string[];
  routingCapabilities: string[];
  source: 'deterministic';
}

/** Server-owned assistant used only to produce reviewable configuration drafts. */
export class SettingsAssistant {
  private readonly llm: InternalLlmService;
  constructor(deps: InternalLlmDependencies | InternalLlmService) {
    this.llm = deps instanceof InternalLlmService ? deps : new InternalLlmService(deps);
  }

  async suggestAgentResponsibility(input: {
    agentClassRef: string;
    sourceText: string;
    modelFacts: readonly SafeModelFact[];
    intent?: string;
  }): Promise<ResponsibilitySuggestion> {
    const sourceText = input.sourceText.trim();
    const body = await this.llm.generate({
      action: 'AI 改写',
      operation: 'responsibility_rewrite',
      data: {
        agentClassRef: input.agentClassRef,
        sourceText,
        intent: input.intent?.trim() ?? '',
        modelFacts: input.modelFacts.map(fact => ({
          modelRef: fact.modelRef, modelId: fact.modelId, capabilities: fact.capabilities,
          description: fact.description, routingNotes: fact.routingNotes,
          contextLimit: fact.contextLimit, publicFacts: fact.publicFacts,
        })),
      },
    });
    const text = parseResponsibility(body);
    if (!text) throw new ResponsibilityRewriteError('AI 返回的职责内容不完整或格式不符合要求，请重试；原文未修改。');
    return {
      sourceText, suggestedText: text,
      selectedModelRefs: input.modelFacts.map(fact => fact.modelRef),
      evidence: ['SettingsAssistant 内置模型建议'],
      requiresConfirmation: true,
    };
  }

  compileCapabilityProfile(input: {
    agentClassRef: string;
    modelFacts: readonly SafeModelFact[];
    declaredRoutingCapabilities?: readonly string[];
  }): CapabilityCompilation {
    return {
      agentClassRef: input.agentClassRef,
      modelRefs: input.modelFacts.map(fact => fact.modelRef),
      capabilities: [...new Set(input.modelFacts.flatMap(fact => fact.capabilities))].sort(),
      routingCapabilities: [...new Set(input.declaredRoutingCapabilities ?? [])].sort(),
      source: 'deterministic',
    };
  }
}

/** Only controlled diagnostics reach the UI; provider response bodies stay private. */
class ResponsibilityRewriteError extends Error {}

const RewriteContentSchema = z.object({
  mission: z.string().trim().min(1).max(1_000),
  tasks: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  deliverables: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  quality: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  boundaries: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
}).strict();

function parseResponsibility(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return undefined;
  const choice = choices[0] as { finish_reason?: unknown; message?: unknown };
  // Never accept truncation, content filtering or a tool call as a complete rewrite.
  if (choice.finish_reason !== undefined && choice.finish_reason !== 'stop') return undefined;
  if (!choice.message || typeof choice.message !== 'object') return undefined;
  const content = (choice.message as { content?: unknown }).content;
  if (typeof content !== 'string' || content.length > 10_000) return undefined;
  try {
    const parsed = RewriteContentSchema.safeParse(JSON.parse(content.trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1')));
    if (!parsed.success) return undefined;
    const sections: Array<[string, string[]]> = [
      ['核心职责', [parsed.data.mission]],
      ['主要任务', parsed.data.tasks],
      ['预期交付物', parsed.data.deliverables],
      ['质量要求', parsed.data.quality],
      ['工作边界', parsed.data.boundaries],
    ];
    const rendered: string[] = [];
    for (const [heading, items] of sections) {
      const cleaned = [...new Set(items.map(item => item
        .replace(/^(?:\s*(?:[-*#]+\s*)?(?:核心职责|主要任务|适用范围|适合接收的任务|预期交付物|质量要求|工作边界|模型适配提示)\s*[：:]\s*)+/u, '')
        .trim()))];
      // Technical terms are fine; untranslated catalog prose is not a rewrite.
      if (cleaned.some(item => !/\p{Script=Han}/u.test(item)
        || /(?:[A-Za-z][A-Za-z0-9.'’/-]*[ ,;]+){11}[A-Za-z]/u.test(item)
        || /(?:核心职责|主要任务|预期交付物|质量要求|工作边界)\s*[：:]/u.test(item))) return undefined;
      rendered.push(heading === '核心职责'
        ? `${heading}：${cleaned[0]}`
        : `${heading}：\n${cleaned.map(item => `- ${item}`).join('\n')}`);
    }
    const text = rendered.join('\n\n');
    return text.length <= 2_000 ? text : undefined;
  } catch {
    return undefined;
  }
}
