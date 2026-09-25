import type {
  BeginQueryInput,
  BeginQueryResult,
  BindTaskResult,
} from './query-context-service.js';
import type { QueryTaskLink } from './ports.js';

export interface QueryUsageLifecycle {
  beginQuery(input: BeginQueryInput): BeginQueryResult;
  bindCostTask(input: {
    readonly queryId: string;
    readonly taskId: string;
    readonly decisionId: string;
    readonly basis: QueryTaskLink['basis'];
    readonly linkedAt: string;
  }): BindTaskResult;
  getCostTaskId(queryId: string): string | null;
  finalizeQueriesForTask(taskId: string, finalizedAt: string): void;
  finalizeQuery(input: {
    readonly queryId: string;
    readonly finalizedAt: string;
  }): void;
}
