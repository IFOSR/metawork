import { z } from 'zod';
import type { ModelRoutingNotes } from './types.js';
import type { OpenRouterModelMetadata } from './openrouter-model-catalog.js';
import { InternalLlmService } from './internal-llm-service.js';

const Text = z.string().trim().min(1).max(500);
const Notes = z.object({
  summary: Text,
  strengths: z.array(Text).max(8),
  limitations: z.array(Text).max(8),
  preferredTaskTypes: z.array(Text).max(8),
  avoidTaskTypes: z.array(Text).max(8),
}).strict();

/** Produces soft routing evidence only; cannot grant hard capabilities or permissions. */
export class ModelRoutingProfileService {
  constructor(private readonly llm: InternalLlmService) {}

  async summarize(model: OpenRouterModelMetadata): Promise<ModelRoutingNotes> {
    const response = await this.llm.generate({
      action: '模型信息提炼',
      operation: 'model_summary',
      data: {
        modelId: model.modelId, description: model.description,
        capabilities: model.capabilities, contextLimit: model.contextLimit,
        publicFacts: model.publicFacts,
        costInputCnyPerMillion: model.costInputPerMillion,
        costOutputCnyPerMillion: model.costOutputPerMillion,
      },
    });
    try {
      const choices = (response as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> })?.choices;
      const choice = choices?.[0];
      if (!choice?.message?.content || (choice.finish_reason && choice.finish_reason !== 'stop')) throw new Error();
      const notes = Notes.parse(JSON.parse(choice.message.content.trim()
        .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1')));
      if (!/\p{Script=Han}/u.test(notes.summary)) throw new Error();
      return notes;
    } catch {
      throw new Error('模型信息提炼结果不完整或格式无效，原能力描述未修改，请重试。');
    }
  }
}
