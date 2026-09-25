import type {
  BillingDiagnosticCode,
  ConversationTurnProjection,
  QueryBillProjection,
} from '../api/session-types';
import { BILLING_DIAGNOSTIC_MESSAGES, BILLING_STATUS_LABELS } from '../api/session-types';

interface BillingFacts {
  turnId: string;
  queryId: string | null;
  taskId: string | null;
  userStatus: 'billed' | 'unconfirmed' | 'no_charge';
  amountMicroCoin: string | null;
  amountIsFinal: boolean;
  diagnosticCode: BillingDiagnosticCode | null;
  diagnosticMessage: string | null;
  usageBreakdown: NonNullable<QueryBillProjection['usageBreakdown']>;
  stageBreakdown: NonNullable<QueryBillProjection['stageBreakdown']>;
}

/** Server 视图优先；旧记录只有 queryBill 时仍可展示。 */
export function turnBillingFacts(turn: ConversationTurnProjection): BillingFacts | null {
  const view = turn.turnBilling;
  if (view) {
    return {
      turnId: view.turnId,
      queryId: view.queryId,
      taskId: view.taskId,
      userStatus: view.userStatus,
      amountMicroCoin: view.amountMicroCoin,
      amountIsFinal: view.amountIsFinal,
      diagnosticCode: view.diagnosticCode,
      diagnosticMessage: view.diagnosticMessage
        ?? (view.diagnosticCode ? BILLING_DIAGNOSTIC_MESSAGES[view.diagnosticCode] : null),
      usageBreakdown: view.usageBreakdown ?? turn.queryBill?.usageBreakdown ?? [],
      stageBreakdown: view.stageBreakdown ?? turn.queryBill?.stageBreakdown ?? [],
    };
  }
  const bill = turn.queryBill;
  if (!bill) return null;
  const userStatus = bill.userStatus
    ?? (bill.state === 'finalized'
      ? (bill.assessedMicroCoin !== '0' ? 'billed' : 'no_charge')
      : 'unconfirmed');
  const diagnosticCode = bill.diagnosticCode
    ?? (bill.state === 'collecting' ? 'query_not_finalized' : null);
  const amount = userStatus === 'unconfirmed'
    ? null
    : bill.assessedMetaCoin ?? (userStatus === 'no_charge' ? '0' : null);
  return {
    turnId: turn.id,
    queryId: bill.queryId,
    taskId: bill.taskId,
    userStatus,
    amountMicroCoin: amount,
    amountIsFinal: bill.assessedIsFinal,
    diagnosticCode,
    diagnosticMessage: bill.diagnosticMessage
      ?? (diagnosticCode ? BILLING_DIAGNOSTIC_MESSAGES[diagnosticCode] : null),
    usageBreakdown: bill.usageBreakdown ?? [],
    stageBreakdown: bill.stageBreakdown ?? [],
  };
}

function stageLabel(stage: string | null): string {
  return ({
    intake: '接收',
    context: '上下文',
    planning: 'Planner',
    execution: 'Executor',
    verification: '校验',
    delivery: '交付',
  } as Record<string, string>)[stage ?? ''] ?? stage ?? '未细分';
}

export function TurnBillCard({
  turn,
  taskTitle,
  onOpenBilling,
}: {
  turn: ConversationTurnProjection;
  taskTitle?: string | null;
  onOpenBilling?: () => void;
}) {
  const facts = turnBillingFacts(turn);
  if (!facts) return null;
  const rows = facts.stageBreakdown.length > 0
    ? facts.stageBreakdown
    : facts.usageBreakdown.map(entry => ({
      stage: null,
      agentClassRef: entry.agentClassRef,
      providerRef: entry.providerRef,
      modelId: entry.modelId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      assessedMetaCoin: null,
      costStatus: 'pending' as const,
    }));
  return (
    <section className="turn-bill" data-status={facts.userStatus} aria-label="本次账单">
      <header>
        <span>本次账单</span>
        <strong data-status={facts.userStatus}>{BILLING_STATUS_LABELS[facts.userStatus]}</strong>
      </header>
      <dl>
        <dt>费用</dt>
        <dd>
          {facts.amountMicroCoin === null
            ? <span className="turn-bill-unknown">暂无法计算</span>
            : <strong className="turn-bill-amount">
                {facts.amountMicroCoin} MetaCoin{facts.amountIsFinal ? '' : '（暂计）'}
              </strong>}
        </dd>
        {(taskTitle ?? facts.taskId) && (
          <><dt>关联任务</dt><dd>{taskTitle ?? facts.taskId}</dd></>
        )}
      </dl>
      {rows.length > 0 && (
        <section className="turn-bill-usage" aria-label="阶段与模型用量">
          <h4>阶段与模型用量</h4>
          <div className="turn-bill-usage-list">
            {rows.map((entry, index) => (
              <div
                className="turn-bill-usage-row"
                key={`${entry.stage ?? 'unknown'}:${entry.agentClassRef ?? 'unknown'}:${entry.providerRef ?? 'unknown'}:${entry.modelId ?? 'unknown'}:${index}`}
              >
                <div className="turn-bill-usage-identity">
                  <strong>{stageLabel(entry.stage)} · {entry.agentClassRef ?? '未知 Agent'}</strong>
                  <span>
                    {entry.providerRef ?? '未知 Provider'} / {entry.modelId ?? '未知 Model'}
                  </span>
                </div>
                <span>Input {entry.inputTokens}</span>
                <span>Output {entry.outputTokens}</span>
                <span>合计 {entry.totalTokens}</span>
                <strong>
                  {entry.assessedMetaCoin === null
                    ? '费用待确认'
                    : `${entry.assessedMetaCoin} MetaCoin`}
                </strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {facts.userStatus === 'unconfirmed' && facts.diagnosticMessage && (
        <p className="turn-bill-diagnostic">
          {facts.diagnosticMessage}
          {facts.diagnosticCode && <code>{facts.diagnosticCode}</code>}
        </p>
      )}
      {onOpenBilling && facts.queryId && (
        <button type="button" className="turn-bill-open" onClick={onOpenBilling}>
          查看账单详情 →
        </button>
      )}
    </section>
  );
}
