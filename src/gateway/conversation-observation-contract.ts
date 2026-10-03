import type { ConversationViewChange } from '../session/conversation-read-types.js';
import type { ConversationActivityView } from '../session/conversation-activity-types.js';

export const OBSERVATION_CAPABILITY = 'conversation_observation_v1';
export const MAX_CONNECTION_OBSERVATIONS = 8;
export const MAX_OBSERVATION_FRAME_BYTES = 64 * 1024;

export type ConversationObservationFrame = {
  readonly observationId: string;
  readonly conversationId: string;
} & (
  | { readonly kind: 'baseline'; readonly transferId: string; readonly index: number; readonly count: number;
      readonly byteLength: number; readonly hash: string; readonly data: string }
  | { readonly kind: 'patch'; readonly change: ConversationViewChange }
  | { readonly kind: 'activity'; readonly view: ConversationActivityView; readonly revision: string }
  | { readonly kind: 'freshness'; readonly sourceSequence: number | null; readonly projectedSequence: number;
      readonly preparing: boolean }
  | { readonly kind: 'reset'; readonly reason: 'cursor_expired' | 'projection_changed' }
  | { readonly kind: 'closed'; readonly reason: 'authorization_revoked' | 'slow_consumer' | 'read_unavailable' }
);
