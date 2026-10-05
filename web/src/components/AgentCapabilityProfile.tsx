import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { AgentCapabilityDescription } from '../api/types';
import type { AgentClassRoutingFacts, SettingsModelEntry } from '../settings-model';
import { AiActionStatus, type AiActionFeedback, sameAiText, aiActionError } from './AiActionStatus';

export function AgentCapabilityProfile({ http, facts, models }: {
  http?: HttpClient | null;
  facts: AgentClassRoutingFacts;
  models: SettingsModelEntry[];
}) {
  const inputKey = JSON.stringify({
    kind: facts.kind,
    affordances: facts.affordances,
    models: models.map(model => ({
      modelRef: model.ref, modelId: model.modelId, capabilities: model.capabilities,
      description: model.description, routingNotes: model.routingNotes,
      publicFacts: model.publicFacts, contextLimit: model.contextLimit,
    })),
  });
  const [request, setRequest] = useState<{ key: string; sequence: number }>({ key: '', sequence: 0 });
  const [result, setResult] = useState<{ key: string; description: AgentCapabilityDescription; previous?: AgentCapabilityDescription }>();
  const latestResult = useRef(result);
  latestResult.current = result;
  const [feedback, setFeedback] = useState<AiActionFeedback & { key: string; initial?: boolean }>();
  const requestSequence = request.key === inputKey ? request.sequence : 0;

  useEffect(() => {
    let cancelled = false;
    if (!http || models.length === 0) { setFeedback(undefined); return; }
    const startedAt = Date.now();
    const previous = latestResult.current?.key === inputKey ? latestResult.current.description : undefined;
    setFeedback({ key: inputKey, status: 'loading', startedAt });
    void http.describeAgentCapabilities({ ...JSON.parse(inputKey), refresh: requestSequence > 0 })
      .then(description => {
        if (cancelled) return;
        const unchanged = previous && sameCapabilityDescription(previous, description);
        setResult({ key: inputKey, description: unchanged ? previous : description, previous });
        setFeedback({ key: inputKey, status: unchanged ? 'unchanged' : 'updated', startedAt, completedAt: Date.now(), initial: !previous });
      })
      .catch((cause: Error) => {
        if (!cancelled) setFeedback({ key: inputKey, status: 'error', startedAt, completedAt: Date.now(), message: aiActionError(cause) });
      });
    return () => { cancelled = true; };
  }, [http, inputKey, requestSequence]);

  // Never present a previous selection's capabilities as the current Agent's.
  const description = result?.key === inputKey ? result.description : undefined;
  const currentFeedback = feedback?.key === inputKey ? feedback : undefined;
  const loading = currentFeedback?.status === 'loading';
  return (
    <section className="executor-auto-capabilities agent-capability-profile" aria-label="智能体能力" aria-busy={loading}>
      <div className="capability-profile-heading">
        <div>
          <span className="fact-label">智能体能力</span>
          <small className="field-help">了解这个智能体能处理什么，以及可用范围。</small>
        </div>
        <button type="button" className="ghost-button" disabled={!http || models.length === 0 || loading}
          onClick={() => setRequest({ key: inputKey, sequence: requestSequence + 1 })}>
          {loading ? '正在整理…' : '能力更新'}
        </button>
      </div>
      {models.length === 0 ? <p className="field-help">选择模型后，自动整理智能体能力。</p> : (
        <>
          {currentFeedback && <AiActionStatus feedback={currentFeedback}
            title={loading ? '正在更新能力说明'
              : currentFeedback.status === 'error' ? '能力更新失败'
                : currentFeedback.status === 'unchanged' ? '已检查，内容无变化'
                  : currentFeedback.initial ? '能力说明已就绪' : '能力更新成功'}
            detail={loading ? (description ? '正在调用 AI 检查与整理；下方仍为更新前说明。' : '正在调用 AI 整理当前智能体能力，完成后将在下方显示。')
              : currentFeedback.status === 'error' ? `${currentFeedback.message} ${description ? '下方保留更新前说明。' : '尚未生成能力说明。'} 可点击“能力更新”重试。`
                : currentFeedback.status === 'unchanged' ? '本次返回内容与更新前一致，无需替换；下方保留原有说明。'
                  : currentFeedback.initial ? '下方已显示当前选择对应的能力说明。' : '下方已显示更新后说明。'} />}
          {!http && <p className="field-help">能力整理服务暂不可用。</p>}
          {description && <>
            <p className="agent-capability-summary">{description.summary}</p>
            <dl className="agent-capability-list">
              {description.abilities.map((ability, index) => <div key={`${ability.title}-${index}`}>
                <dt>{ability.title}</dt><dd>{ability.description}</dd>
              </div>)}
            </dl>
            {description.boundaries.length > 0 && <div className="agent-capability-boundaries">
              <span className="fact-label">使用边界</span>
              <ul>{description.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul>
            </div>}
            {result?.previous && currentFeedback?.status !== 'loading' && currentFeedback?.status !== 'error' && (
              <details className="ai-version-comparison">
                <summary>查看更新前说明</summary>
                <p>{result.previous.summary}</p>
                <ul>{result.previous.abilities.map((ability, index) => <li key={index}><strong>{ability.title}：</strong>{ability.description}</li>)}</ul>
                {result.previous.boundaries.length > 0 && <><strong>使用边界</strong><ul>{result.previous.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></>}
              </details>
            )}
          </>}
        </>
      )}
    </section>
  );
}

function sameCapabilityDescription(left: AgentCapabilityDescription, right: AgentCapabilityDescription): boolean {
  const texts = (value: AgentCapabilityDescription) => [value.summary,
    ...value.abilities.flatMap(ability => [ability.title, ability.description]), ...value.boundaries];
  const before = texts(left);
  const after = texts(right);
  return left.abilities.length === right.abilities.length && left.boundaries.length === right.boundaries.length
    && before.length === after.length && before.every((text, index) => sameAiText(text, after[index]!));
}
