import type { SpanRoutingDraft } from '../config-edit';

export interface SpanRoutingSettingsProps {
  draft: SpanRoutingDraft;
  /** Server-reported credential state; the plaintext key is never returned. */
  credentialConfigured: boolean;
  editingDisabled: boolean;
  onChange(next: SpanRoutingDraft): void;
}

/**
 * Advanced-settings editor for the optional routing decision model.
 *
 * Presentation only: it edits draft state and hands it to the existing
 * configuration activation flow. It never persists a credential and never shows
 * a stored key. The advisor model is fixed by the backend, so this surface
 * exposes no model or provider picker — the operator only decides whether to
 * enable the advisor and, if so, supplies the OpenRouter credential.
 */
export function SpanRoutingSettings({
  draft,
  credentialConfigured,
  editingDisabled,
  onChange,
}: SpanRoutingSettingsProps) {
  return (
    <section className="settings-section" aria-labelledby="decision-model-heading">
      <div className="section-heading">
        <div>
          <div className="settings-eyebrow">DECISION MODEL</div>
          <h3 id="decision-model-heading">决策模型</h3>
          <p>
            一个可选的排序服务：在已经合格的执行模型里挑出更合适的一个。不开启时系统
            使用内置规则，任务照常执行。
          </p>
        </div>
        <span className={`state-badge${draft.enabled ? '' : ' state-badge-warning'}`}>
          {draft.enabled ? '已开启' : '未开启'}
        </span>
      </div>

      <dl className="decision-model-explainer">
        <div className="decision-model-point">
          <dt>它做什么</dt>
          <dd>
            执行模型候选先通过可执行性、能力等硬性筛选，再由决策模型做一次软排序，
            选出更合适的执行模型。它只决定用哪个模型，不改变任务内容、权限或执行结果。
          </dd>
        </div>
        <div className="decision-model-point">
          <dt>开启与关闭</dt>
          <dd>
            开启后每次派发任务前都会调用一次决策模型；关闭后改用内置的确定性规则选择
            执行模型，执行不受影响，已保存的 API Key 也会保留。
          </dd>
        </div>
        <div className="decision-model-point">
          <dt>发送什么数据</dt>
          <dd>
            只把任务摘要和候选模型信息发送到 OpenRouter 用于排序判断，不包含附件内容、
            完整会话或仓库代码。
          </dd>
        </div>
      </dl>

      <label className="decision-toggle" data-enabled={draft.enabled}>
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          disabled={editingDisabled}
          onChange={event => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span className="decision-toggle-copy">
          <strong>启用决策模型</strong>
          <small>
            {draft.enabled
              ? '已开启：派发任务前会调用一次决策模型。'
              : credentialConfigured
                ? '开启需要填写 OpenRouter API Key；关闭时会保留已保存的 Key。'
                : '开启需要填写 OpenRouter API Key。'}
          </small>
        </span>
      </label>

      {draft.enabled && (
        <div className="decision-credential">
          <div className="decision-credential-head">
            <label htmlFor="span-routing-api-key">OpenRouter API Key</label>
            <span className={`credential-chip ${credentialConfigured ? 'credential-chip-set' : 'credential-chip-missing'}`}>
              {credentialConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <input
            id="span-routing-api-key"
            className="text-input"
            type="password"
            autoComplete="off"
            placeholder={credentialConfigured ? '已配置（留空表示保留）' : '粘贴你的 OpenRouter API Key'}
            value={draft.apiKey}
            disabled={editingDisabled}
            onChange={event => onChange({ ...draft, apiKey: event.target.value })}
          />
          <small className="decision-credential-note">
            Key 由服务端保存到 SecretStore，不会写入配置版本或日志，也不会发送给执行器。
          </small>
          {!credentialConfigured && (
            <p className="decision-credential-warning" role="status">
              还没有可用的 Key：填写并保存后决策模型才会生效。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
