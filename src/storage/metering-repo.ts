/**
 * `MeteringStore` 的 SQLite 实现（ADR-0042 §7.2）。
 *
 * 观测以 `(source_id, source_event_key, metric)` 唯一约束保证重放不重复计量；
 * 累计快照由观测表本身推导，不额外追加陈旧快照行。
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type {
  MeteringSpanRecord,
  MeteringStore,
  PersistedUsageObservation,
} from '../metering/ports.js';
import type { CumulativeSnapshot, NormalizationIssue } from '../metering/usage-normalizer.js';

interface SpanRow {
  span_id: string;
  query_id: string;
  execution_segment_id: string | null;
  source_id: string;
  source_scope: MeteringSpanRecord['sourceScope'];
  call_id: string;
  stage: MeteringSpanRecord['stage'];
  reason: MeteringSpanRecord['reason'];
  state: MeteringSpanRecord['state'];
  payer: MeteringSpanRecord['payer'];
  started_at: string;
  closed_at: string | null;
}

interface ObservationRow {
  cumulative_value: string | null;
  observation_id: string;
  span_id: string | null;
  source_id: string;
  source_event_key: string;
  source_scope: PersistedUsageObservation['sourceScope'];
  call_id: string;
  query_id: string;
  execution_segment_id: string | null;
  task_id: string | null;
  stage: PersistedUsageObservation['stage'];
  reason: PersistedUsageObservation['reason'];
  resource: PersistedUsageObservation['resource'];
  metric: string;
  unit: string;
  quantity_numerator: string;
  quantity_denominator: string;
  quality: PersistedUsageObservation['quality'];
  counts_toward_total: number;
  payer: PersistedUsageObservation['payer'];
  agent_class_ref: string | null;
  provider_ref: string | null;
  model_id: string | null;
  captured_at: string;
  provider_binding_version: string | null;
  evidence_ref: string | null;
  normalization_rule_version: string;
}

export class SqliteMeteringStore implements MeteringStore {
  constructor(
    private readonly db: Database.Database,
    private readonly createId: (prefix: string) => string = prefix => `${prefix}_${nanoid(12)}`,
  ) {}

  openSpan(span: MeteringSpanRecord): void {
    this.db.prepare(`
      INSERT INTO metering_spans (
        span_id, query_id, execution_segment_id, source_id, source_scope, call_id,
        stage, reason, state, payer, started_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, call_id) DO NOTHING
    `).run(
      span.spanId,
      span.queryId,
      span.executionSegmentId,
      span.sourceId,
      span.sourceScope,
      span.callId,
      span.stage,
      span.reason,
      span.state,
      span.payer,
      span.startedAt,
      span.closedAt,
    );
  }

  closeSpan(spanId: string, state: 'closed' | 'uncertain', closedAt: string): boolean {
    return this.db.prepare(`
      UPDATE metering_spans
      SET state = ?, closed_at = ?
      WHERE span_id = ? AND state = 'started'
    `).run(state, closedAt, spanId).changes === 1;
  }

  listOpenSpans(queryId: string): MeteringSpanRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM metering_spans
      WHERE query_id = ? AND state = 'started'
      ORDER BY started_at, span_id
    `).all(queryId) as SpanRow[];
    return rows.map(rowToSpan);
  }

  listSpans(queryId: string): MeteringSpanRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM metering_spans
      WHERE query_id = ?
      ORDER BY started_at, span_id
    `).all(queryId) as SpanRow[];
    return rows.map(rowToSpan);
  }

  listSpansForQueries(queryIds: readonly string[]): MeteringSpanRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM metering_spans WHERE query_id IN (SELECT value FROM json_each(?))
      ORDER BY started_at, span_id
    `).all(JSON.stringify(queryIds)) as SpanRow[];
    return rows.map(rowToSpan);
  }

  listObservationsForQueries(queryIds: readonly string[]): PersistedUsageObservation[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_observations WHERE query_id IN (SELECT value FROM json_each(?))
      ORDER BY captured_at, observation_id
    `).all(JSON.stringify(queryIds)) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  insertObservations(observations: readonly PersistedUsageObservation[]): number {
    const statement = this.db.prepare(`
      INSERT INTO usage_observations (
        observation_id, span_id, source_id, source_event_key, source_scope, call_id,
        query_id, execution_segment_id, task_id, stage, reason, resource, metric, unit,
        quantity_numerator, quantity_denominator, quality, counts_toward_total, payer,
        agent_class_ref, provider_ref, model_id, captured_at, provider_binding_version,
        evidence_ref, normalization_rule_version, cumulative_value
      ) VALUES (
        @observation_id, @span_id, @source_id, @source_event_key, @source_scope, @call_id,
        @query_id, @execution_segment_id, @task_id, @stage, @reason, @resource, @metric, @unit,
        @quantity_numerator, @quantity_denominator, @quality, @counts_toward_total, @payer,
        @agent_class_ref, @provider_ref, @model_id, @captured_at, @provider_binding_version,
        @evidence_ref, @normalization_rule_version, @cumulative_value
      )
      ON CONFLICT(source_id, source_event_key, metric) DO NOTHING
    `);
    return this.db.transaction(() => {
      let inserted = 0;
      for (const observation of observations) {
        inserted += statement.run({
          observation_id: observation.observationId,
          span_id: observation.spanId,
          source_id: observation.sourceId,
          source_event_key: observation.sourceEventKey,
          source_scope: observation.sourceScope,
          call_id: observation.callId,
          query_id: observation.queryId,
          execution_segment_id: observation.executionSegmentId,
          task_id: observation.taskId,
          stage: observation.stage,
          reason: observation.reason,
          resource: observation.resource,
          metric: observation.metric,
          unit: observation.unit,
          quantity_numerator: observation.quantityNumerator,
          quantity_denominator: observation.quantityDenominator,
          quality: observation.quality,
          counts_toward_total: observation.countsTowardTotal ? 1 : 0,
          payer: observation.payer,
          agent_class_ref: observation.agentClassRef ?? null,
          provider_ref: observation.providerRef ?? null,
          model_id: observation.modelId ?? null,
          captured_at: observation.capturedAt,
          provider_binding_version: observation.providerBindingVersion,
          evidence_ref: observation.evidenceRef,
          normalization_rule_version: observation.normalizationRuleVersion,
          cumulative_value: observation.cumulativeValue ?? null,
        }).changes;
      }
      return inserted;
    }).immediate();
  }

  listObservations(queryId: string): PersistedUsageObservation[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_observations WHERE query_id = ?
      ORDER BY captured_at, observation_id
    `).all(queryId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  listObservationsForTask(taskId: string): PersistedUsageObservation[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_observations WHERE task_id = ?
      ORDER BY captured_at, observation_id
    `).all(taskId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * 累计快照取自最后一次观测：累计计数器只有在同一 `(source, call, metric)`
   * 下单调递增时才作为差值来源。
   */
  listCumulativeSnapshots(sourceIds: readonly string[]): CumulativeSnapshot[] {
    if (sourceIds.length === 0) return [];
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT source_id, call_id, metric, cumulative_value
      FROM usage_observations
      WHERE source_id IN (${placeholders}) AND cumulative_value IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM usage_observations newer
          WHERE newer.source_id = usage_observations.source_id
            AND newer.call_id = usage_observations.call_id
            AND newer.metric = usage_observations.metric
            AND newer.cumulative_value IS NOT NULL
            AND (
              newer.captured_at > usage_observations.captured_at
              OR (newer.captured_at = usage_observations.captured_at
                AND newer.observation_id > usage_observations.observation_id)
            )
        )
      ORDER BY source_id, call_id, metric
    `).all(...sourceIds) as Array<{
      source_id: string;
      call_id: string;
      metric: string;
      cumulative_value: string;
    }>;
    return rows.map(row => ({
      sourceId: row.source_id,
      callId: row.call_id,
      metric: row.metric,
      value: row.cumulative_value,
    }));
  }

  recordIssues(issues: readonly (NormalizationIssue & { queryId: string })[]): void {
    const statement = this.db.prepare(`
      INSERT INTO usage_normalization_issues (
        issue_id, query_id, source_id, source_event_key, code, detail, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const issue of issues) {
        statement.run(
          this.createId('issue'),
          issue.queryId,
          issue.sourceId,
          issue.sourceEventKey,
          issue.code,
          issue.detail,
          now,
        );
      }
    }).immediate();
  }

  listIssues(queryId: string): Array<NormalizationIssue & { queryId: string }> {
    const rows = this.db.prepare(`
      SELECT query_id, source_id, source_event_key, code, detail
      FROM usage_normalization_issues
      WHERE query_id = ?
      ORDER BY recorded_at, issue_id
    `).all(queryId) as Array<{
      query_id: string;
      source_id: string;
      source_event_key: string;
      code: string;
      detail: string;
    }>;
    return rows.map(row => ({
      queryId: row.query_id,
      sourceId: row.source_id,
      sourceEventKey: row.source_event_key,
      code: row.code as NormalizationIssue['code'],
      detail: row.detail,
    }));
  }
}

function rowToSpan(row: SpanRow): MeteringSpanRecord {
  return {
    spanId: row.span_id,
    queryId: row.query_id,
    executionSegmentId: row.execution_segment_id,
    sourceId: row.source_id,
    sourceScope: row.source_scope,
    callId: row.call_id,
    stage: row.stage,
    reason: row.reason,
    state: row.state,
    payer: row.payer,
    startedAt: row.started_at,
    closedAt: row.closed_at,
  };
}

function rowToObservation(row: ObservationRow): PersistedUsageObservation {
  return {
    cumulativeValue: row.cumulative_value,
    observationId: row.observation_id,
    spanId: row.span_id,
    sourceId: row.source_id,
    sourceEventKey: row.source_event_key,
    sourceScope: row.source_scope,
    callId: row.call_id,
    queryId: row.query_id,
    executionSegmentId: row.execution_segment_id,
    taskId: row.task_id,
    stage: row.stage,
    reason: row.reason,
    resource: row.resource,
    metric: row.metric,
    unit: row.unit,
    quantityNumerator: row.quantity_numerator,
    quantityDenominator: row.quantity_denominator,
    quality: row.quality,
    countsTowardTotal: row.counts_toward_total === 1,
    payer: row.payer,
    agentClassRef: row.agent_class_ref,
    providerRef: row.provider_ref,
    modelId: row.model_id,
    capturedAt: row.captured_at,
    providerBindingVersion: row.provider_binding_version,
    evidenceRef: row.evidence_ref,
    normalizationRuleVersion: row.normalization_rule_version,
  };
}
