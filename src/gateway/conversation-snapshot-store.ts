import type { GatewayEventEnvelope } from './client-events.js';
import { buildReplaySnapshot } from './file-event-journal.js';

export const CONVERSATION_SNAPSHOT_VERSION = 1;
export const MAX_CONVERSATION_SNAPSHOT_BYTES = 256 * 1024;

/** Incremental presentation projection; the audit remains in immutable segments. */
export function projectConversationSnapshot(
  previous: readonly GatewayEventEnvelope[],
  appended: readonly GatewayEventEnvelope[],
): GatewayEventEnvelope[] {
  const events = [...previous, ...appended].filter(event => ![
    'workspace_directory_snapshot', 'workspace_activity_changed', 'workspace_conversation_upserted',
    'workspace_conversation_removed', 'workspace_availability_changed',
    'conversation_history_page', 'command_completion', 'task_view_snapshot', 'usage_billing_projection',
  ].includes(event.kind));
  const reverse = [...events].reverse();
  const latestTurn = (reverse.find(event => event.kind === 'turn_started' && event.turnId)
    ?? reverse.find(event => event.turnId))?.turnId;
  const current = events.filter(event => !event.turnId || event.turnId === latestTurn);
  const snapshots = buildReplaySnapshot(current);
  const included = new Set(snapshots.map(event => event.eventId));
  // Intake and permission facts are needed for a live Turn, not only terminal snapshots.
  const latestByKind = new Map<string, GatewayEventEnvelope>();
  for (const event of current) if (!included.has(event.eventId)) latestByKind.set(snapshotKey(event), event);
  const singleton = new Map<string, GatewayEventEnvelope>();
  const chunks: GatewayEventEnvelope[] = [];
  for (const event of [...snapshots, ...latestByKind.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (event.kind === 'result_chunk') chunks.push(event);
    else singleton.set(snapshotKey(event), event);
  }
  const omitted = new Set(current.filter(event => payload(event).snapshotContentOmitted === true)
    .map(event => payload(event).resultId));
  const offsets = new Map<unknown, number>();
  for (const chunk of chunks) {
    const data = payload(chunk);
    const offset = offsets.get(data.resultId) ?? 0;
    if (data.offset !== offset || typeof data.chunk !== 'string') omitted.add(data.resultId);
    else offsets.set(data.resultId, offset + Buffer.byteLength(data.chunk));
  }
  for (const event of singleton.values()) {
    const data = payload(event);
    if (event.kind === 'result_completed' && typeof data.byteLength === 'number'
      && data.byteLength !== (offsets.get(data.resultId) ?? 0)) omitted.add(data.resultId);
  }
  let projected = [...singleton.values(), ...chunks.filter(event => !omitted.has(payload(event).resultId))]
    .sort((a, b) => a.sequence - b.sequence);
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_CONVERSATION_SNAPSHOT_BYTES) {
    // Never return a partial result chunk set claiming to be complete.
    for (const chunk of chunks) omitted.add(payload(chunk).resultId);
    projected = projected.filter(event => event.kind !== 'result_chunk');
  }
  projected = projected.map(event => omitted.has(payload(event).resultId) && [
    'result_delivery_available', 'result_completed',
  ].includes(event.kind) ? { ...event, payload: { ...payload(event), snapshotContentOmitted: true } } : event);
  while (projected.length > 1 && Buffer.byteLength(JSON.stringify(projected)) > MAX_CONVERSATION_SNAPSHOT_BYTES) {
    const discard = projected.findIndex(event => event.kind === 'trace_delta');
    const nonIntake = projected.findIndex(event => event.kind !== 'turn_started' && event.kind !== 'conversation_snapshot');
    projected.splice(discard >= 0 ? discard : nonIntake >= 0 ? nonIntake : 0, 1);
  }
  return projected;
}

function payload(event: GatewayEventEnvelope): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown> : {};
}

function snapshotKey(event: GatewayEventEnvelope): string {
  const data = payload(event);
  if (event.kind === 'artifact') {
    const artifact = data.artifact && typeof data.artifact === 'object' ? data.artifact as Record<string, unknown> : data;
    return `${event.kind}:${artifact.artifactId ?? event.eventId}`;
  }
  if (event.kind === 'permission_request') return `${event.kind}:${data.requestId ?? event.eventId}`;
  if (['result_delivery_available', 'result_completed', 'delivery_status'].includes(event.kind)) {
    return `${event.kind}:${data.resultId ?? event.eventId}`;
  }
  return event.kind;
}
