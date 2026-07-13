const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|credential|authorization|private[_-]?key|connection[_-]?string)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const OPENAI_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/g;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi;

/** Redacts common secret forms before diagnostic text crosses a trust boundary. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(OPENAI_TOKEN_PATTERN, '[REDACTED]')
    .replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}[REDACTED]`;
    });
}
