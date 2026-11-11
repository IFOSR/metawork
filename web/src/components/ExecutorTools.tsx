import { useEffect, useState } from 'react';
import type { AgentReadiness } from '../api/types';
import type { HttpClient } from '../api/http';
import { desktopBridge } from '../platform/services';

export function ExecutorTools({ agents, http, disabled }: {
  agents: AgentReadiness[]; http: HttpClient | null; disabled: boolean;
}) {
  const [current, setCurrent] = useState(agents);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => setCurrent(agents), [agents]);
  useEffect(() => {
    if (!http) return;
    let disposed = false;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void http.refreshAgentReadiness().then(result => {
        if (!disposed) setCurrent(result.agents);
      }).catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.removeEventListener('focus', refresh); };
  }, [http]);
  const bridge = desktopBridge();
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch { setMessage('操作未完成，请重试。'); }
    finally { setBusy(false); }
  };
  return <section className="settings-section executor-tools" aria-labelledby="executor-tools-heading">
    <div className="section-heading"><h3 id="executor-tools-heading">执行工具</h3></div>
    <div className="executor-tools-list">
      {current.filter(agent => agent.agentId === 'pi-agent').map(agent => {
        const managed = agent.managed || Boolean(bridge);
        const path = agent.status === 'installed' ? agent.path : undefined;
        const status = agent.status === 'installed' ? '已就绪'
          : agent.status === 'checking' ? '检测中' : agent.status === 'missing' ? '未找到' : '暂不可用';
        return <article key={agent.agentId} className="executor-tool-card">
          <div className="executor-tool-header">
            <div className="executor-tool-title">
              <h4>Pi</h4>
              <span className="executor-tool-kind">{managed ? '内置' : '必需'}</span>
              {agent.version && <span className="executor-tool-version">{agent.version}</span>}
            </div>
            <span className="executor-tool-status" data-status={agent.status}>
              <span aria-hidden="true" />{status}
            </span>
          </div>
          {managed && <p className="executor-tool-description">随 MetaWork 更新</p>}
          {path && <details className="executor-tool-path">
            <summary>程序路径</summary><code>{path}</code>
          </details>}
          {agent.status === 'broken' && agent.detail && <details className="executor-tool-path">
            <summary>查看原因</summary><p>{agent.detail}</p>
          </details>}
          {managed && agent.status !== 'installed' && agent.status !== 'checking' && bridge?.repairPi && <div className="executor-tool-actions">
            <button type="button" className="ghost-button" disabled={disabled || busy} onClick={() => void run(async () => {
              setMessage('正在恢复执行组件…');
              const result = await bridge.repairPi!(); setMessage(result.message);
            })}>重试恢复</button>
          </div>}

        </article>;
      })}
    </div>
    <div role="status" aria-live="polite" className="executor-tools-message">{message}</div>
  </section>;
}
