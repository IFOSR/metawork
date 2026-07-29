// Memory context module: deterministic planning context reads and inline resource normalization.
import type { ConversationTurn } from './conversation-turn.js';
import type { MemoryEngine } from './memory-engine.js';
import type { ContextRecaller } from './context-recaller.js';
import { extractInlineResourceMatches, stripInlineResourceMatches } from '../intent/inline-resource-normalizer.js';

export interface PlanningInitialContextResult {
  longTermMemories: Array<{
    id: string;
    type: string;
    scope: string;
    subject: string | null;
    content: string;
  }>;
  conversationHistory: Array<{
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: string;
  }>;
}

export interface InlineResourceNormalizationResult {
  normalizedGoal: string;
  resources: string[];
}

export interface MemoryContextServiceDeps {
  memoryEngine: MemoryEngine;
  contextRecaller: ContextRecaller;
}

export class MemoryContextService {
  constructor(private readonly deps: MemoryContextServiceDeps) {}

  async preparePlanningInitialContext(input: {
    sessionId: string;
    userInput: string;
    topK: number;
  }): Promise<PlanningInitialContextResult> {
    const longTermMemories = this.deps.memoryEngine
      .list({ status: 'confirmed' })
      .filter(preference => preference.scope === 'global')
      .slice(0, input.topK)
      .map(preference => ({
        id: preference.id,
        type: preference.type,
        scope: preference.scope,
        subject: preference.subject,
        content: preference.content,
      }));
    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: '',
      sessionId: input.sessionId,
      userInput: input.userInput,
    });

    return {
      longTermMemories,
      conversationHistory: conversationHistory.map(turn => ({
        userInput: turn.userInput,
        systemOutput: turn.systemOutput,
        createdAt: turn.createdAt,
        source: turn.source,
      })),
    };
  }

  normalizeInlineResources(input: string, resources: string[], stripResource: (text: string) => string): InlineResourceNormalizationResult {
    return {
      normalizedGoal: stripResource(input) || input,
      resources,
    };
  }

  normalizeInlineResourcesFromInput(input: string, cwd = process.cwd()): InlineResourceNormalizationResult {
    const matches = extractInlineResourceMatches(input, cwd);
    return {
      normalizedGoal: stripInlineResourceMatches(input, matches) || input,
      resources: matches.map(match => match.resolvedPath),
    };
  }
}
