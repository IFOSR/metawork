import type Database from 'better-sqlite3';
import type { ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

const HISTORICAL_COMPLETION_MARKER = '<!-- metaclaw:completion:v3 -->';

export interface HistoricalResultUpgrade {
  resultId: string;
  content: string;
  completeness: 'partial';
  certification: 'uncertified';
}

export class HistoricalResultUpgrader {
  private readonly results: ResultObjectRepo;

  constructor(private readonly deps: {
    db: Database.Database;
    accountId: string;
    resultRoot: string;
  }) {
    this.results = new ResultObjectRepo(deps.db, deps.resultRoot);
  }

  upgrade(receipt: ExecutorAttemptReceipt): HistoricalResultUpgrade | null {
    if (
      receipt.terminalState !== 'contract_blocked'
      || (receipt.completionSchemaVersion ?? 0) > 3
      || 'completionAssessment' in receipt.parsing
    ) {
      return null;
    }
    const body = extractHistoricalBody(receipt.rawResponse);
    if (!body) return null;
    const common = {
      accountId: this.deps.accountId,
      taskId: receipt.taskId,
      generationId: receipt.generationId,
      sourceSubtaskId: receipt.subtaskId,
      attemptId: receipt.attemptId,
      completeness: 'partial' as const,
      retentionClass: 'task',
      createdAt: receipt.completedAt,
    };
    this.results.putObject({
      ...common,
      resultId: `result_${receipt.attemptId}_raw`,
      kind: 'raw_attempt_output',
      mediaType: 'text/markdown',
      content: receipt.rawResponse,
    });
    this.results.putObject({
      ...common,
      resultId: `result_${receipt.attemptId}_business`,
      kind: 'business_result',
      mediaType: 'text/markdown',
      content: body,
    });
    const safe = this.results.putObject({
      ...common,
      resultId: `result_${receipt.attemptId}_safe`,
      kind: 'safe_projection',
      mediaType: 'text/markdown',
      content: redactSensitiveText(body),
    });
    return {
      resultId: safe.resultId,
      content: this.results.readRange(safe.resultId, 0, safe.byteLength).content,
      completeness: 'partial',
      certification: 'uncertified',
    };
  }
}

function extractHistoricalBody(rawResponse: string): string | null {
  const markerIndex = rawResponse.indexOf(HISTORICAL_COMPLETION_MARKER);
  const body = (markerIndex >= 0
    ? rawResponse.slice(0, markerIndex)
    : rawResponse
  ).trim();
  return body || null;
}
