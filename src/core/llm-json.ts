// Shared helper for pulling a single JSON object out of noisy LLM/Codex text
// output. Models frequently wrap JSON in prose or ```json fences; this tolerates
// both by stripping fences first, then falling back to a braces-span extraction.

export function extractJsonObject(raw: string): unknown {
  const cleaned = stripJsonFences(raw).trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('LLM output did not contain a JSON object');
    }
    return JSON.parse(match[0]);
  }
}

function stripJsonFences(raw: string): string {
  return raw.replace(/```json\n?/g, '').replace(/```\n?/g, '');
}
