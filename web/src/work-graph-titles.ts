import type { WorkGraphPresentationProjection } from './api/types';

export type WorkGraphTitleIndex = ReadonlyMap<string, string>;

export function workGraphTitleIndex(
  projection: WorkGraphPresentationProjection | null | undefined,
): WorkGraphTitleIndex {
  return new Map(projection?.nodes.map(node => [node.id, node.title]) ?? []);
}

export function subtaskTitle(
  titles: WorkGraphTitleIndex | undefined,
  id: string,
  fallback: string,
): string {
  return titles?.get(id) || fallback || id;
}
