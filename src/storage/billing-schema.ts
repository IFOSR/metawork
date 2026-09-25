/**
 * 计量与账单的 SQLite schema（ADR-0042 §7.2）。
 *
 * 金额一律以有约束的十进制文本保存（分子/分母或 microCoin 整数），聚合在
 * 精确金额层完成，不使用 SQLite 浮点 SUM。表由 `runMigrations` 在新建库和
 * 38→39 升级时创建，39→40/40→41 只补充字段，禁止删表/清库切换。
 */

import type Database from 'better-sqlite3';

export const BILLING_SCHEMA_VERSION = 41;

export const BILLING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS query_usage_contexts (
  query_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ingress TEXT NOT NULL CHECK(ingress IN ('web', 'feishu', 'tui', 'cli', 'system')),
  request_key TEXT NOT NULL,
  request_payload_digest TEXT NOT NULL,
  conversation_id TEXT,
  request_id TEXT NOT NULL,
  turn_id TEXT,
  execution_segment_id TEXT,
  price_book_version TEXT NOT NULL,
  fee_policy_version TEXT NOT NULL,
  payer_policy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  external_account_ref TEXT,
  UNIQUE(account_id, ingress, request_key)
);

CREATE TABLE IF NOT EXISTS query_task_links (
  query_id TEXT PRIMARY KEY,
  cost_task_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK(basis IN ('authorized_application', 'authorized_execution_segment')),
  linked_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);
CREATE INDEX IF NOT EXISTS idx_query_task_links_task ON query_task_links(cost_task_id);

CREATE TABLE IF NOT EXISTS execution_usage_contexts (
  execution_segment_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('planner_run', 'task_generation', 'attempt', 'resume_segment')),
  reference_id TEXT NOT NULL,
  task_id TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);
CREATE INDEX IF NOT EXISTS idx_execution_usage_contexts_query
  ON execution_usage_contexts(query_id);
CREATE INDEX IF NOT EXISTS idx_execution_usage_contexts_reference
  ON execution_usage_contexts(kind, reference_id);

CREATE TABLE IF NOT EXISTS metering_spans (
  span_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  execution_segment_id TEXT,
  source_id TEXT NOT NULL,
  source_scope TEXT NOT NULL CHECK(source_scope IN (
    'model_request', 'harness_turn', 'attempt', 'resource_allocation'
  )),
  call_id TEXT NOT NULL,
  stage TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started', 'closed', 'uncertain')),
  payer TEXT NOT NULL CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(source_id, call_id),
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);
CREATE INDEX IF NOT EXISTS idx_metering_spans_query ON metering_spans(query_id, state);

CREATE TABLE IF NOT EXISTS usage_observations (
  observation_id TEXT PRIMARY KEY,
  span_id TEXT,
  source_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  source_scope TEXT NOT NULL CHECK(source_scope IN (
    'model_request', 'harness_turn', 'attempt', 'resource_allocation'
  )),
  call_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  execution_segment_id TEXT,
  task_id TEXT,
  stage TEXT,
  reason TEXT NOT NULL,
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity_numerator TEXT NOT NULL,
  quantity_denominator TEXT NOT NULL DEFAULT '1',
  quality TEXT NOT NULL CHECK(quality IN ('reported', 'estimated', 'unavailable')),
  counts_toward_total INTEGER NOT NULL CHECK(counts_toward_total IN (0, 1)),
  payer TEXT NOT NULL CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
  agent_class_ref TEXT,
  provider_ref TEXT,
  model_id TEXT,
  captured_at TEXT NOT NULL,
  provider_binding_version TEXT,
  evidence_ref TEXT,
  normalization_rule_version TEXT NOT NULL,
  cumulative_value TEXT,
  UNIQUE(source_id, source_event_key, metric),
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_observations_query
  ON usage_observations(query_id, resource, metric);
CREATE INDEX IF NOT EXISTS idx_usage_observations_task
  ON usage_observations(task_id);

CREATE TABLE IF NOT EXISTS usage_normalization_issues (
  issue_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_normalization_issues_query
  ON usage_normalization_issues(query_id);

CREATE TABLE IF NOT EXISTS billing_price_versions (
  price_book_version TEXT PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'CNY',
  markup_bps TEXT NOT NULL,
  fee_policy_version TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  exchange_rate_json TEXT NOT NULL DEFAULT 'null',
  units_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_entries (
  cost_entry_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  task_id TEXT,
  stage TEXT,
  price_book_version TEXT NOT NULL,
  payer TEXT NOT NULL CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
  disposition TEXT NOT NULL CHECK(disposition IN ('eligible', 'absorbed', 'pending')),
  reason TEXT NOT NULL,
  cost_kind TEXT NOT NULL CHECK(cost_kind IN ('reference', 'verified_actual')),
  cost_nano_cny_numerator TEXT NOT NULL,
  cost_nano_cny_denominator TEXT NOT NULL DEFAULT '1',
  recorded_at TEXT NOT NULL,
  evidence_ref TEXT,
  UNIQUE(observation_id, cost_kind, price_book_version),
  FOREIGN KEY (observation_id) REFERENCES usage_observations(observation_id)
);
CREATE INDEX IF NOT EXISTS idx_cost_entries_query ON cost_entries(query_id, disposition);

CREATE TABLE IF NOT EXISTS query_bills (
  bill_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  external_account_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('collecting', 'pending_reconciliation', 'finalized')),
  billable_base_nano_cny_numerator TEXT NOT NULL DEFAULT '0',
  billable_base_nano_cny_denominator TEXT NOT NULL DEFAULT '1',
  amount_micro_coin TEXT NOT NULL DEFAULT '0',
  price_book_version TEXT NOT NULL,
  fee_policy_version TEXT NOT NULL,
  payer_policy_version TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('complete', 'partial', 'incomplete')),
  coverage_note TEXT,
  platform_absorption_json TEXT NOT NULL DEFAULT 'null',
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);
CREATE INDEX IF NOT EXISTS idx_query_bills_task ON query_bills(task_id, state);
CREATE INDEX IF NOT EXISTS idx_query_bills_account ON query_bills(account_id, state);

CREATE TABLE IF NOT EXISTS query_bill_lines (
  bill_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  stage TEXT,
  amount_micro_coin TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (bill_id, line_id),
  FOREIGN KEY (bill_id) REFERENCES query_bills(bill_id)
);

CREATE TABLE IF NOT EXISTS consumption_outbox (
  bill_id TEXT PRIMARY KEY,
  source_instance_id TEXT NOT NULL,
  external_account_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  amount_micro_coin TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'not_exported', 'pending', 'received', 'confirmed', 'unknown', 'rejected'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_instance_id, bill_id),
  FOREIGN KEY (bill_id) REFERENCES query_bills(bill_id)
);
CREATE INDEX IF NOT EXISTS idx_consumption_outbox_state
  ON consumption_outbox(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS consumption_receipts (
  receipt_id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('received', 'applied', 'rejected', 'unknown')),
  external_entry_id TEXT,
  applied_amount_micro_coin TEXT,
  reason TEXT,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES consumption_outbox(bill_id)
);
CREATE INDEX IF NOT EXISTS idx_consumption_receipts_bill
  ON consumption_receipts(bill_id, observed_at);

CREATE TABLE IF NOT EXISTS bill_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_micro_coin TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  external_state TEXT NOT NULL DEFAULT 'not_exported' CHECK(external_state IN (
    'not_exported', 'pending', 'received', 'confirmed', 'unknown', 'rejected'
  )),
  external_reference TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES query_bills(bill_id)
);
CREATE INDEX IF NOT EXISTS idx_bill_adjustments_bill ON bill_adjustments(bill_id);

CREATE TABLE IF NOT EXISTS billing_source_instance (
  source_instance_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

export function createBillingSchema(db: Database.Database): void {
  db.exec(BILLING_SCHEMA_SQL);
}
