import type { AgentClass } from '../core/types.js';

export interface AgentClassLookupPort {
  findByName(name: string): AgentClass | null;
  listAgentClasses(): AgentClass[];
  setResolvedImageId?(name: string, imageId: string): void;
}
