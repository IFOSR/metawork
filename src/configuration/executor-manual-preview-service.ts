import { buildExecutorManualPreview } from './projections.js';
import type { ConfigurationService } from './configuration-service.js';
import { validateExecutorManualSourceText } from './executor-manual-source.js';
import type {
  AnyFusionConfigurationV2,
  ExecutorManualUserProfile,
  PlannerExecutorCapabilityManual,
} from './types.js';

export interface ExecutorManualAnalysisInput {
  baseRevisionId: string;
  agentClassRef: string;
  sourceText: string;
  candidateConfig?: AnyFusionConfigurationV2;
}

export interface ExecutorManualAnalysisResult {
  agentClassRef: string;
  configurationRevision: string;
  sourceText: string;
  analysisMode: 'source-preserved';
  userProfile: ExecutorManualUserProfile;
  manual: PlannerExecutorCapabilityManual;
  config: AnyFusionConfigurationV2;
}

/**
 * Deterministic preview for the existing manual API. The user's prose is already
 * routing evidence; it does not need another LLM call or semantic receipt.
 * Explicit AI editing belongs to InternalLlmService, never to the task Planner.
 */
export class ExecutorManualPreviewService {
  constructor(private readonly configuration: ConfigurationService) {}

  async compile(input: ExecutorManualAnalysisInput): Promise<ExecutorManualAnalysisResult> {
    const sourceText = input.sourceText.trim();
    validateExecutorManualSourceText(sourceText);
    // Resolve the requested revision exactly; a stale preview cannot silently
    // incorporate a different active configuration.
    const base = await this.configuration.getSnapshot(input.baseRevisionId);
    const config = structuredClone(input.candidateConfig ?? base.config);
    const agent = config.agentClasses[input.agentClassRef];
    if (!agent || agent.kind !== 'executor') {
      throw new Error(`unknown Executor AgentClass: ${input.agentClassRef}`);
    }
    const saved = base.config.agentClasses[input.agentClassRef]?.executorManual;
    // Reuse only persisted assertions for unchanged prose, never assertions
    // supplied by the client. New prose remains prose, not authority to grant
    // protocols, permissions, or inferred capability-policy assertions.
    agent.executorManual = saved && sourceText === saved.sourceText.trim()
      ? structuredClone(saved)
      : { sourceText, assertions: [] };
    agent.responsibility = sourceText;
    const draft = this.configuration.createDraft(config, input.baseRevisionId);
    try {
      const validation = this.configuration.validateDraft(draft.revisionId);
      if (!validation.ok) {
        throw new Error(validation.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
      }
      this.configuration.compileDraft(draft.revisionId);
      const snapshot = this.configuration.getDraftSnapshot(draft.revisionId);
      return {
        agentClassRef: input.agentClassRef,
        configurationRevision: snapshot.revisionId,
        sourceText,
        analysisMode: 'source-preserved',
        userProfile: snapshot.config.agentClasses[input.agentClassRef]!.executorManual!,
        manual: buildExecutorManualPreview(snapshot, input.agentClassRef),
        config: snapshot.config,
      };
    } finally {
      this.configuration.discardDraft(draft.revisionId);
    }
  }
}
