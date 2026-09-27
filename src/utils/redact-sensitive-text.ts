const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|credential|authorization|private[_-]?key|connection[_-]?string)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const OPENAI_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/g;
const URL_USERINFO_PATTERN = /:\/\/[^@\s/]+@/g;

/** Redacts common secret forms before diagnostic text crosses a trust boundary. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(OPENAI_TOKEN_PATTERN, '[REDACTED]')
    .replace(URL_USERINFO_PATTERN, (match, offset: number, source: string) => {
      // Anchor at ://, not at every possible scheme character. The old
      // unanchored scheme prefix rescanned every suffix of long plain words.
      for (let index = offset - 1; index >= 0; index -= 1) {
        const character = source[index]!;
        if (/[a-z]/i.test(character)) return '://[REDACTED]@';
        if (!/[0-9+.-]/.test(character)) break;
      }
      return match;
    })
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}[REDACTED]`;
    });
}
