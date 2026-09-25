import type { QueryBillProjection } from '../api/session-types';
import { QueryBill } from './QueryBill';

/**
 * 当前 Query 的账单详情。
 *
 * 历史账单不在这里聚合：用户先从左侧 Conversation 列表选择历史会话，
 * 再查看该会话当前选中 Turn 的 Query 账单，避免把“当前 Query”和“账户历史”
 * 混成一个页面。
 */
export function BillingView({
  bill,
  requestSummary,
  taskTitle,
}: {
  bill: QueryBillProjection | null;
  requestSummary?: string | null;
  taskTitle?: string | null;
}) {
  if (!bill) {
    return (
      <div className="billing-view billing-empty-state" aria-label="账单">
        <span className="billing-kicker">CURRENT QUERY</span>
        <h2>当前 Query 暂无账单</h2>
        <p>
          选择左侧会话并完成一个任务后，这里会显示该 Query 的阶段、模型、Token
          和 MetaCoin 明细。历史会话的账单也会随会话切换。
        </p>
      </div>
    );
  }

  return (
    <div className="billing-view" aria-label="当前 Query 账单">
      <header className="billing-context">
        <div>
          <span className="billing-kicker">CURRENT QUERY BILL</span>
          <h2>{requestSummary?.trim() || '当前 Query'}</h2>
        </div>
        {taskTitle && <span className="billing-context-task">{taskTitle}</span>}
      </header>
      <QueryBill bill={bill} />
    </div>
  );
}
