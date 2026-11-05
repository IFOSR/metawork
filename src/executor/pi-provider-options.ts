// Installed Pi releases may turn the model catalog's fallback maxTokens into
// a request cap. MetaWork does not configure an output budget: leave optional
// OpenAI limits to the provider, including on response-only corrections.
export const PI_PROVIDER_OPTIONS_EXTENSION_SOURCE = `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('before_provider_request', (event, context) => {
    const api = context.model?.api;
    if (api !== 'openai-responses' && api !== 'openai-completions'
      && api !== 'azure-openai-responses' && api !== 'openai-codex-responses') return;
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return;
    const payload = { ...event.payload } as Record<string, unknown>;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    delete payload.max_tokens;
    return payload;
  });
}
`;
