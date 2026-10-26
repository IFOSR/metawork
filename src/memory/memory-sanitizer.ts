/**
 * Memory sanitizer — the pre-deposit purifier for long-term memory.
 *
 * Design §8: the memory engine will keep whatever we deposit alive for a long
 * time and replay it into future tasks, so a secret pasted once in chat would
 * otherwise become a durable, injectable secret. The rules are reused from the
 * retired candidate scanner; only the decision changed:
 *
 *   - secret-like content  -> redacted before it is written;
 *   - dangerous commands   -> kept, but the source is marked `sanitized`;
 *   - content that is still secret-like after redaction -> refused entirely.
 *
 * Pure module: no repository, http or planner imports.
 */

export type MemorySanitizeStatus = 'passed' | 'sanitized' | 'refused';

export interface MemorySanitizeResult {
  status: MemorySanitizeStatus;
  /** Text that is safe to deposit. Empty when refused. */
  content: string;
  reasons: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(api[_-]?key|token|password|secret)\s*=\s*[^\s]+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKID[A-Za-z0-9]{12,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * A private key whose footer is missing cannot be masked as a whole block.
 * Such content is refused instead of deposited.
 */
const RESIDUAL_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//i,
  /\bchmod\s+777\b/i,
  /\bcurl\b[^|\n]*\|\s*(?:sh|bash)\b/i,
];

const REDACTION = '[REDACTED]';

export class MemorySanitizer {
  /**
   * Purify one turn body. Returns `refused` when a secret survives redaction,
   * which keeps the content out of the engine entirely.
   */
  sanitize(content: string): MemorySanitizeResult {
    const reasons = new Set<string>();
    let sanitized = content;

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(sanitized)) {
        reasons.add('contains_secret');
        sanitized = sanitized.replace(pattern, REDACTION);
      }
    }

    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(content)) reasons.add('contains_dangerous_command');
    }

    // A secret that the patterns could not fully mask must not be deposited.
    if (looksLikeUnmaskedSecret(sanitized)) {
      return {
        status: 'refused',
        content: '',
        reasons: [...reasons, 'unmasked_secret'],
      };
    }

    const status: MemorySanitizeStatus = reasons.size === 0
      ? 'passed'
      : reasons.has('contains_dangerous_command') && !reasons.has('contains_secret')
        ? 'sanitized'
        : 'sanitized';
    return { status, content: sanitized, reasons: [...reasons] };
  }

  /**
   * Purify a whole batch. A refused turn is dropped; the remaining turns keep
   * their order so that the engine still sees a coherent dialogue.
   */
  sanitizeTurns<T extends { userInput: string; assistantAnswer: string }>(turns: readonly T[]):
    { turns: T[]; refused: number; sanitized: number } {
    const kept: T[] = [];
    let refused = 0;
    let sanitized = 0;
    for (const turn of turns) {
      const user = this.sanitize(turn.userInput);
      const assistant = this.sanitize(turn.assistantAnswer);
      if (user.status === 'refused' || assistant.status === 'refused') {
        refused += 1;
        continue;
      }
      if (user.status === 'sanitized' || assistant.status === 'sanitized') sanitized += 1;
      kept.push({ ...turn, userInput: user.content, assistantAnswer: assistant.content });
    }
    return { turns: kept, refused, sanitized };
  }
}

/**
 * Heuristic guard for credentials the pattern list does not cover. It only
 * fires on high-signal shapes so that ordinary prose is never refused.
 */
function looksLikeUnmaskedSecret(content: string): boolean {
  // Redaction markers are safe; look at the rest of the text only.
  const withoutMarkers = content.replaceAll(REDACTION, '');
  return RESIDUAL_PRIVATE_KEY_PATTERN.test(withoutMarkers);
}
