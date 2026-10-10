import { z } from 'zod';
import { InternalLlmService } from './internal-llm-service.js';

const ModelFactSchema = z.object({
  modelRef: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  capabilities: z.array(z.string().max(100)).max(50),
  description: z.string().max(20_000).optional(),
  contextLimit: z.number().finite().positive().optional(),
  publicFacts: z.object({
    inputModalities: z.array(z.string().max(100)).max(20),
    outputModalities: z.array(z.string().max(100)).max(20),
    supportedParameters: z.array(z.string().max(100)).max(100),
    highlights: z.array(z.string().max(2_000)).max(30),
  }).optional(),
  routingNotes: z.object({
    summary: z.string().max(5_000).optional(),
    strengths: z.array(z.string().max(1_000)).max(20).optional(),
    limitations: z.array(z.string().max(1_000)).max(20).optional(),
    preferredTaskTypes: z.array(z.string().max(1_000)).max(20).optional(),
    avoidTaskTypes: z.array(z.string().max(1_000)).max(20).optional(),
  }).optional(),
});

export const AgentCapabilityDescriptionInputSchema = z.object({
  kind: z.enum(['planner', 'executor']),
  affordances: z.array(z.string().max(200)).max(50),
  models: z.array(ModelFactSchema).min(1).max(50),
});
export type AgentCapabilityDescriptionInput = z.infer<typeof AgentCapabilityDescriptionInputSchema>;

const ChineseText = z.string().trim().min(1).max(400).refine(text => /\p{Script=Han}/u.test(text));
const DescriptionSchema = z.object({
  summary: ChineseText,
  abilities: z.array(z.object({ title: ChineseText, description: ChineseText }).strict()).min(1).max(6),
  boundaries: z.array(ChineseText).max(3),
}).strict();
export type AgentCapabilityDescription = z.infer<typeof DescriptionSchema>;

/** Read-only explanation; never writes routing capabilities, duties or permissions. */
export class AgentCapabilityDescriptionService {
  private readonly descriptions = new Map<string, Promise<AgentCapabilityDescription>>();
  constructor(private readonly llm: InternalLlmService) {}

  async describe(input: AgentCapabilityDescriptionInput, refresh = false): Promise<AgentCapabilityDescription> {
    const data = AgentCapabilityDescriptionInputSchema.parse(input);
    const key = JSON.stringify(data);
    if (!refresh && this.descriptions.has(key)) return this.descriptions.get(key)!;
    const pending = this.generate(data);
    this.descriptions.set(key, pending);
    if (this.descriptions.size > 64) this.descriptions.delete(this.descriptions.keys().next().value!);
    try { return await pending; }
    catch (error) {
      if (this.descriptions.get(key) === pending) this.descriptions.delete(key);
      throw error;
    }
  }

  private async generate(data: AgentCapabilityDescriptionInput): Promise<AgentCapabilityDescription> {
    const response = await this.llm.generate({
      action: '智能体能力整理',
      operation: 'capability_explanation',
      data,
    });
    try {
      const choice = (response as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> })?.choices?.[0];
      if (!choice?.message?.content || (choice.finish_reason && choice.finish_reason !== 'stop')) throw new Error();
      const result = DescriptionSchema.parse(JSON.parse(choice.message.content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1')));
      const text = JSON.stringify(result).toLowerCase();
      if (data.models.some(model => text.includes(model.modelId.toLowerCase()))) throw new Error();
      return result;
    } catch {
      throw new Error('智能体能力说明生成不完整或仍包含模型介绍，请重试。');
    }
  }
}
