/**
 * Workspace execution is deliberately not configurable. The only supported
 * write admission is direct execution in the Conversation-bound Workspace.
 * This parser remains as a fail-closed reader for old configuration files.
 */
export function parseWorkspaceExecutionConfiguration(value: unknown): Record<string, never> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (record && Object.hasOwn(record, 'fallbackMode') && record.fallbackMode !== undefined) {
    throw new Error('workspaceExecution.fallbackMode is retired; Workspace writes always run in place');
  }
  return {};
}
