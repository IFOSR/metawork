export const CONVERSATION_BASELINE_BYTES = 256 * 1024;
export const CONVERSATION_PREVIEW_BYTES = 4 * 1024;

export interface ConversationContentReference {
  readonly hash: string;
  readonly byteLength: number;
}

/** Small entities only. Trace, artifacts, billing and full content are separate resources. */
export interface ConversationTurnView {
  readonly id: string;
  readonly conversationId: string;
  readonly requestId: string | null;
  readonly revision: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly userInput: string;
  readonly userInputRef: ConversationContentReference | null;
  readonly answer: string;
  readonly answerRef: ConversationContentReference | null;
  readonly resultId: string | null;
  readonly certification: 'certified' | 'uncertified' | null;
  readonly completeness: 'complete' | 'partial' | 'incomplete' | null;
  readonly resultOffset: number;
  readonly resultPreviewOmitted: boolean;
  readonly status: 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  readonly deliveryStatus: 'none' | 'streaming' | 'verifying' | 'ready' | 'failed';
  readonly taskId: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly interactionKind: 'system_command' | 'ai_turn';
}

export interface ConversationViewCursor {
  readonly epoch: string;
  readonly revision: number;
}

export interface ConversationReadHead extends ConversationViewCursor {
  readonly journalSequence: number;
}

export interface ConversationTurnPage {
  readonly asOf?: ConversationViewCursor;
  readonly turns: readonly ConversationTurnView[];
  readonly nextCursor: string | null;
}

export interface ConversationReadBaseline extends ConversationTurnPage {
  readonly head: ConversationReadHead | null;
}

export interface ConversationViewChange extends ConversationViewCursor {
  readonly removed?: true;
  readonly prevRevision: number;
  readonly turn: ConversationTurnView;
}
