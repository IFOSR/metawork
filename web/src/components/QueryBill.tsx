import type { QueryBillProjection } from '../api/session-types';
import { BILLING_STATUS_LABELS } from '../api/session-types';

const stageLabels: Record<string, string> = {
  intake: '接收',
  context: '上下文',
  planning: 'Planner',
  execution: 'Executor',
  verification: '校验',
  delivery: '交付',
};

const costStatusLabels = {
  calculated: '已计算',
  not_chargeable: '不单独计费',
  pending: '待确认',
} as const;

/**
 * 账单详情投影视图（账单简化设计 §3.2/§4）。
 * 只展示当前 Query 的 Server 投影事实；不把内部账单状态和外部消费状态
 * 堆叠给用户，避免把本次费用误解为第三方扣款状态。
 */
export function QueryBill({
  bill,
  providerDisplayName,
  modelDisplayName,
}: {
  bill: QueryBillProjection;
  providerDisplayName?: string | null;
  modelDisplayName?: string | null;
}) {
  const status = bill.userStatus
    ?? (bill.state === 'finalized'
      ? (bill.assessedMicroCoin !== '0' ? 'billed' : 'no_charge')
      : 'unconfirmed');
  return (
    <section className="query-bill" aria-label="账单详情">
      <header><span>账单详情</span><strong>{BILLING_STATUS_LABELS[status]}</strong></header>
      <dl>
        <dt>金额</dt>
        <dd>
          {status === 'unconfirmed'
            ? '暂无法计算'
            : <strong>{bill.assessedMetaCoin ?? '金额不可用'} MetaCoin{bill.assessedIsFinal ? '' : '（暂计）'}</strong>}
        </dd>
        {bill.diagnosticCode && (
          <>
            <dt>诊断</dt>
            <dd><code>{bill.diagnosticCode}</code> · {bill.diagnosticMessage}</dd>
          </>
        )}
        <dt>Query ID</dt><dd><code>{bill.queryId}</code></dd>
        {bill.turnId && <><dt>Turn ID</dt><dd><code>{bill.turnId}</code></dd></>}
        {bill.taskId && <><dt>Task ID</dt><dd><code>{bill.taskId}</code></dd></>}
        {providerDisplayName && <><dt>Provider</dt><dd>{providerDisplayName}</dd></>}
        {modelDisplayName && <><dt>Model</dt><dd>{modelDisplayName}</dd></>}
        <dt>usage 观测数</dt><dd>{bill.observedUsageCount ?? 0}</dd>
        {(bill.missingCategories?.length ?? 0) > 0 && (
          <>
            <dt>缺失类别</dt>
            <dd><code>{bill.missingCategories!.join('、')}</code></dd>
          </>
        )}
        {bill.coverage !== 'complete' && (
          <><dt>完整性</dt><dd>不完整{bill.coverageNote ? ` · ${bill.coverageNote}` : ''}</dd></>
        )}
        {bill.finalizedAt && <><dt>终结时间</dt><dd>{bill.finalizedAt}</dd></>}
        {bill.createdAt && <><dt>创建时间</dt><dd>{bill.createdAt}</dd></>}
      </dl>
      {bill.lines.length > 0 && (
        <ul className="query-bill-lines">{bill.lines.map((line, index) => (
          <li key={`${line.stage ?? 'unknown'}-${index}`}>
            <span>{line.stage ?? '阶段未细分'}</span>
            <strong>{line.amountMetaCoin ?? '金额不可用'} MetaCoin</strong>
          </li>
        ))}</ul>
      )}
      {(bill.usageBreakdown?.length ?? 0) > 0 && (
        <section className="query-bill-usage" aria-label="模型 Token 用量">
          <h4>模型用量</h4>
          <div className="query-bill-usage-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache Read</th>
                  <th>Cache Write</th>
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {bill.usageBreakdown!.map(entry => (
                  <tr
                    key={`${entry.agentClassRef ?? 'unknown'}:${entry.providerRef ?? 'unknown'}:${entry.modelId ?? 'unknown'}`}
                  >
                    <td>{entry.agentClassRef ?? '未知'}</td>
                    <td>{entry.providerRef ?? '未知'}</td>
                    <td>{entry.modelId ?? '未知'}</td>
                    <td>{entry.inputTokens}</td>
                    <td>{entry.outputTokens}</td>
                    <td>{entry.cacheReadTokens}</td>
                    <td>{entry.cacheWriteTokens}</td>
                    <td><strong>{entry.totalTokens}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {(bill.stageBreakdown?.length ?? 0) > 0 && (
        <section className="query-bill-stage-breakdown" aria-label="阶段费用明细">
          <h4>阶段费用明细</h4>
          <div className="query-bill-usage-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>Agent / Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Token 合计</th>
                  <th>费用</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {bill.stageBreakdown!.map((entry, index) => (
                  <tr key={`${entry.stage ?? 'unknown'}:${entry.agentClassRef ?? 'unknown'}:${entry.modelId ?? 'unknown'}:${index}`}>
                    <td>{entry.stage ? (stageLabels[entry.stage] ?? entry.stage) : '未细分'}</td>
                    <td>
                      {entry.agentClassRef ?? '未知 Agent'}
                      {' / '}
                      {entry.providerRef ?? '未知 Provider'}
                      {' / '}
                      {entry.modelId ?? '未知 Model'}
                    </td>
                    <td>{entry.inputTokens}</td>
                    <td>{entry.outputTokens}</td>
                    <td><strong>{entry.totalTokens}</strong></td>
                    <td>
                      {entry.assessedMetaCoin === null
                        ? '暂无法确认'
                        : `${entry.assessedMetaCoin} MetaCoin`}
                    </td>
                    <td title={entry.costReason ?? undefined}>
                      {costStatusLabels[entry.costStatus]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
