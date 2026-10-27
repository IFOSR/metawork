import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';

type Changes = NonNullable<GatewayTaskViewSnapshot['workspaceChanges']>;

const COVERAGE_NOTE: Record<Changes['coverage'], string> = {
  complete: '本轮改动已完整记录',
  partial: '改动记录范围有限（不影响任务完成状态）',
  unavailable: '暂时无法核对改动范围（不代表任务失败）',
};

const MISSING_REASON_NOTE: Record<string, string> = {
  filesystem_scope_limited: '当前 Workspace 不是 Git 仓库，只核对了授权范围内的文件。',
  git_timeout: 'Git 改动核对超时，只显示了已观察到的文件。',
  git_command_failed: 'Git 改动核对失败，只显示了已观察到的文件。',
  output_limited: '改动记录达到大小上限，只显示了部分文件。',
  shell_unobserved: '通过 Shell 写入的文件无法由文件观察通道完整核对。',
  gitignore_unobserved: '被 .gitignore 忽略的文件可能未出现在改动记录中。',
  git_unavailable: '当前环境无法读取 Git 改动记录。',
};

/**
 * "What changed this round" is an observation, not a delivery receipt. Files the
 * user can open are marked as delivered; scratch output stays visible but muted.
 */
export function WorkspaceChangesCard({ changes, delivered }: { changes: Changes; delivered: readonly string[] }) {
  const deliveredSet = new Set(delivered);
  // In-place Workspace execution updates the user's files directly. An empty
  // public-delivery list therefore does not mean the observed files were not
  // delivered; it means there is no separate publication receipt to compare.
  const hasDeliveryReceipt = delivered.length > 0;
  return (
    <section className="workspace-changes-card" aria-label="本轮改动">
      <header className="workspace-changes-head">
        <span className="workspace-changes-label">本轮改动</span>
        <span className="workspace-changes-count">{changes.totalFiles} 个文件</span>
        <span className="workspace-changes-coverage" data-coverage={changes.coverage}>
          {COVERAGE_NOTE[changes.coverage]}
        </span>
      </header>
      {changes.files.length > 0 && (
        <ul className="workspace-changes-list">
          {changes.files.map(file => (
            <li key={file.path} data-scratch={file.scratch === true}
              data-delivered={hasDeliveryReceipt ? deliveredSet.has(file.path) : undefined}>
              <code>{file.path}</code>
              {file.scratch && <span className="workspace-changes-badge">临时</span>}
              {hasDeliveryReceipt && !file.scratch && !deliveredSet.has(file.path)
                && <span className="workspace-changes-badge">未登记</span>}
            </li>
          ))}
        </ul>
      )}
      {changes.missingReasons.length > 0 && (
        <p className="workspace-changes-reasons">
          {changes.missingReasons.map(reason => MISSING_REASON_NOTE[reason] ?? reason).join(' ')}
        </p>
      )}
    </section>
  );
}
