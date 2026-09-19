import type { AgentReadiness } from '../api/types';
import { requiredAgentBlock } from '../agent-readiness';

export function AgentReadinessBanner({
  agents,
  onRefresh,
  onOpenSettings,
}: {
  agents: AgentReadiness[];
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  const block = requiredAgentBlock(agents);
  const codex = agents.find(agent => agent.agentId === 'codex-cli');
  const showCodexNotice = codex && !codex.required && codex.status !== 'installed';
  // 文案一律用服务端按 AgentClass 解析出的名字，与设置里的“智能体名称”保持一致。
  const requiredAgentName = block.agent?.displayName ?? '必需智能体';

  if (!block.blocked && !showCodexNotice) return null;

  return (
    <section className="agent-readiness-banner" aria-live="polite">
      {block.blocked && (
        <div className="agent-readiness-required">
          <div>
            <strong>{block.message}</strong>
            <p>
              当前启用的助手需要 {requiredAgentName}。请安装该执行工具，或在系统空闲时停用使用它的助手。
            </p>
            {block.agent?.detail && <small>{block.agent.detail}</small>}
          </div>
          <div className="agent-readiness-actions">
            <button
              type="button"
              onClick={() => block.agent?.installUrl && window.open(
                block.agent.installUrl,
                '_blank',
                'noopener,noreferrer',
              )}
            >
              打开安装页面
            </button>
            <button type="button" className="secondary" onClick={onOpenSettings}>设置</button>
            <button type="button" className="secondary" onClick={onRefresh}>重新检测</button>
          </div>
        </div>
      )}
      {showCodexNotice && (
        <div className="agent-readiness-optional">
          <div>
            <strong>{codex.displayName} 未安装，可选增强</strong>
            <p>
              安装后对 GPT/Codex 系列模型的兼容性更强，更适合代码理解、修改、测试和仓库级工程任务，
              并提供额外的执行工具选择。多个助手可以共用同一个工具。
            </p>
          </div>
          <div className="agent-readiness-actions">
            <button
              type="button"
              onClick={() => codex.installUrl && window.open(
                codex.installUrl,
                '_blank',
                'noopener,noreferrer',
              )}
            >
              了解安装方式
            </button>
            <button type="button" className="secondary" onClick={onOpenSettings}>设置</button>
            <button type="button" className="secondary" onClick={onRefresh}>重新检测</button>
          </div>
        </div>
      )}
    </section>
  );
}
