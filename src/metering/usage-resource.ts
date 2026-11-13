export const USAGE_RESOURCES = [
  'model_tokens',
  'image',
  'search',
  'tool_request',
  'compute',
  'storage',
  'network',
] as const;

export type UsageResource = (typeof USAGE_RESOURCES)[number];

export function isUsageResource(value: string): value is UsageResource {
  return (USAGE_RESOURCES as readonly string[]).includes(value);
}
