import type { AgentReadiness } from '../api/types';
import { requiredAgentBlock } from '../agent-readiness';

export function AgentReadinessBanner({
  agents,
  configurationNeeded = false,
  onRefresh,
  onOpenSettings,
}: {
  agents: AgentReadiness[];
  configurationNeeded?: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  const block = requiredAgentBlock(agents);
  // 文案一律用服务端按 AgentClass 解析出的名字，与设置里的“智能体名称”保持一致。
  const requiredAgentName = block.agent?.displayName ?? '必需智能体';

  if (configurationNeeded) return (
    <section className="agent-readiness-banner" aria-live="polite">
      <div className="agent-readiness-required">
        <div>
          <strong>欢迎使用 MetaWork</strong>
          <p>应用已准备就绪。开始工作前，请在设置中添加模型，为规划和执行智能体选择模型并启用，然后保存并激活。</p>
        </div>
        <div className="agent-readiness-actions">
          <button type="button" onClick={onOpenSettings}>配置模型</button>
        </div>
      </div>
    </section>
  );
  if (!block.blocked) return null;

  return (
    <section className="agent-readiness-banner" aria-live="polite">
      {block.blocked && (
        <div className="agent-readiness-required">
          <div>
            <strong>{block.message}</strong>
            <p>
              {block.agent?.managed ? '内置执行组件暂不可用，请在设置中恢复。历史记录和设置仍可使用。' : `开始新工作需要 ${requiredAgentName}，请在设置中检查执行工具。`}
            </p>
            {block.agent?.detail && <small>{block.agent.detail}</small>}
          </div>
          <div className="agent-readiness-actions">
            <button type="button" className="secondary" onClick={onOpenSettings}>设置</button>
            <button type="button" className="secondary" onClick={onRefresh}>重新检测</button>
          </div>
        </div>
      )}
    </section>
  );
}
