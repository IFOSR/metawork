import { useState } from 'react';
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
  const [dismissedStatus, setDismissedStatus] = useState<string | null>(null);
  const block = requiredAgentBlock(agents);
  const codex = agents.find(agent => agent.agentId === 'codex-cli');
  const showCodexNotice = codex && !codex.required && codex.status !== 'installed'
    && codex.status !== 'checking' && dismissedStatus !== codex.status;
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
          <span className="agent-readiness-icon" aria-hidden="true">i</span>
          <div className="agent-readiness-copy">
            <strong>{codex.displayName} · {codex.status === 'broken' ? '暂不可用' : '未检测到'}</strong>
            <p>可选工具，不影响当前工作。已安装？可以重新检测。</p>
            <details className="agent-readiness-details">
              <summary>了解更多</summary>
              <p>用于 GPT/Codex 模型的代码任务，多个智能体可以共用。终端中可用的工具，在桌面应用中可能尚未被识别。</p>
              <div className="agent-readiness-actions">
                <a href={codex.installUrl} target="_blank" rel="noopener noreferrer">安装说明 ↗</a>
                <button type="button" className="secondary" onClick={onOpenSettings}>管理智能体</button>
              </div>
            </details>
          </div>
          <div className="agent-readiness-actions">
            <button type="button" className="secondary" onClick={onRefresh}>重新检测</button>
            <button type="button" className="secondary" onClick={() => setDismissedStatus(codex.status)}
              aria-label="暂时收起可选工具提示" title="本次页面访问内收起，仍可在设置中查看">暂时收起</button>
          </div>
        </div>
      )}
    </section>
  );
}
