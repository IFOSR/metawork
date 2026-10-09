import { useEffect, useState } from 'react';
import type { AgentReadiness } from '../api/types';
import type { HttpClient } from '../api/http';
import { desktopBridge } from '../platform/services';

export function ExecutorTools({ agents, http, command, onCommand, disabled }: {
  agents: AgentReadiness[]; http: HttpClient | null; command: string;
  onCommand: (command: string) => void; disabled: boolean;
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
      {current.map(agent => {
        const pi = agent.agentId === 'pi-agent';
        const managed = pi && (agent.managed || Boolean(bridge));
        const selected = !pi && command !== 'codex' && command !== agent.path;
        const path = !pi && command !== 'codex' ? command : agent.status === 'installed' ? agent.path : undefined;
        const status = agent.status === 'installed' ? '已就绪'
          : agent.status === 'checking' ? '检测中' : agent.status === 'missing' ? '未找到' : '暂不可用';
        return <article key={agent.agentId} className="executor-tool-card">
          <div className="executor-tool-header">
            <div className="executor-tool-title">
              <h4>{pi ? 'Pi' : 'Codex'}</h4>
              <span className="executor-tool-kind">{managed ? '内置' : pi ? '必需' : '可选'}</span>
              {agent.version && <span className="executor-tool-version">{agent.version.replace(/^codex(?:-cli)?\s+/iu, '')}</span>}
            </div>
            <span className="executor-tool-status" data-status={selected ? 'pending' : agent.status}>
              <span aria-hidden="true" />{selected ? '待保存' : status}
            </span>
          </div>
          {managed && <p className="executor-tool-description">随 MetaWork 更新</p>}
          {path && <details className="executor-tool-path" open={selected || undefined}>
            <summary>{selected ? '已选择程序' : '程序路径'}</summary><code>{path}</code>
          </details>}
          {!pi && !path && agent.status !== 'checking' && <p className="executor-tool-description">请选择已安装的 Codex，或查看安装指引。</p>}
          {agent.status === 'broken' && agent.detail && <details className="executor-tool-path">
            <summary>查看原因</summary><p>{agent.detail}</p>
          </details>}
          {!pi && <div className="executor-tool-actions">
            <button type="button" className="ghost-button" disabled={disabled || busy || !bridge?.selectExecutorFile}
              title={!bridge?.selectExecutorFile ? '请在桌面版中选择程序' : undefined}
              onClick={() => void run(async () => {
                const path = await bridge?.selectExecutorFile?.();
                if (path) onCommand(path);
              })}>选择程序</button>
            <a className="ghost-button" href={agent.installUrl} target="_blank" rel="noopener noreferrer">安装指引<span aria-hidden="true"> ↗</span></a>
          </div>}
          {managed && agent.status !== 'installed' && agent.status !== 'checking' && bridge?.repairPi && <div className="executor-tool-actions">
            <button type="button" className="ghost-button" disabled={disabled || busy} onClick={() => void run(async () => {
              setMessage('正在恢复执行组件…');
              const result = await bridge.repairPi!(); setMessage(result.message);
            })}>重试恢复</button>
          </div>}
          {pi && !managed && agent.status !== 'installed' && <div className="executor-tool-actions">
            <a className="ghost-button" href={agent.installUrl} target="_blank" rel="noopener noreferrer">安装指引<span aria-hidden="true"> ↗</span></a>
          </div>}
        </article>;
      })}
    </div>
    <div role="status" aria-live="polite" className="executor-tools-message">{message}</div>
  </section>;
}
