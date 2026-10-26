import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';

type Changes = NonNullable<GatewayTaskViewSnapshot['workspaceChanges']>;

const COVERAGE_NOTE: Record<Changes['coverage'], string> = {
  complete: '本轮改动已完整记录',
  partial: '记录不完整：仅覆盖可观察到的改动',
  unavailable: '无法记录本轮改动',
};

/**
 * "What changed this round" is an observation, not a delivery receipt. Files the
 * user can open are marked as delivered; scratch output stays visible but muted.
 */
export function WorkspaceChangesCard({ changes, delivered }: { changes: Changes; delivered: readonly string[] }) {
  const deliveredSet = new Set(delivered);
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
            <li key={file.path} data-scratch={file.scratch === true} data-delivered={deliveredSet.has(file.path)}>
              <code>{file.path}</code>
              {file.scratch && <span className="workspace-changes-badge">临时</span>}
              {!file.scratch && !deliveredSet.has(file.path) && <span className="workspace-changes-badge">未交付</span>}
            </li>
          ))}
        </ul>
      )}
      {changes.missingReasons.length > 0 && (
        <p className="workspace-changes-reasons">未覆盖原因：{changes.missingReasons.join('、')}</p>
      )}
    </section>
  );
}
