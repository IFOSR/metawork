import type { SpanRoutingDraft } from '../config-edit';
import { SPAN_ROUTING_MODEL } from '../config-edit';

export interface SpanRoutingSettingsProps {
  draft: SpanRoutingDraft;
  /** Server-reported credential state; the plaintext key is never returned. */
  credentialConfigured: boolean;
  editingDisabled: boolean;
  onChange(next: SpanRoutingDraft): void;
}

/**
 * Advanced-settings editor for the Span routing advisor.
 *
 * Presentation only: it edits draft state and hands it to the existing
 * configuration activation flow. It never persists a credential, never shows a
 * stored key, and offers no model/provider selector.
 */
export function SpanRoutingSettings({
  draft,
  credentialConfigured,
  editingDisabled,
  onChange,
}: SpanRoutingSettingsProps) {
  return (
    <section className="runtime-policy-section">
      <div className="section-heading">
        <div>
          <div className="settings-eyebrow">DECISION MODEL</div>
          <h3>决策模型（Span）</h3>
          <p>
            用 Span 对已通过硬约束筛选的执行模型候选进行软排序。服务不可用时会自动
            回退到确定性的本地路由，不会阻塞任务。
          </p>
        </div>
      </div>
      <div className="runtime-policy-grid">
        <label className="settings-field">
          <span>启用 Span 决策模型</span>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={editingDisabled}
            onChange={event => onChange({ ...draft, enabled: event.target.checked })}
          />
          <small>关闭时保留已保存的 API Key，仅停止调用外部服务。</small>
        </label>
        <label className="settings-field">
          <span>固定模型</span>
          <input className="text-input" type="text" value={SPAN_ROUTING_MODEL} readOnly disabled />
          <small>本期只支持该模型，无需选择 Provider。</small>
        </label>
        <label className="settings-field">
          <span>OpenRouter API Key</span>
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            placeholder={credentialConfigured ? '已配置（留空表示保留）' : '未配置'}
            value={draft.apiKey}
            disabled={editingDisabled}
            onChange={event => onChange({ ...draft, apiKey: event.target.value })}
          />
          <small>
            Key 由服务端保存到 SecretStore，不会写入配置版本、日志或发送给执行器。
          </small>
        </label>
      </div>
      <div className="routing-section-note">
        启用后会把必要的任务摘要与候选模型信息发送到 OpenRouter 用于排序判断；
        不包含附件内容、完整会话或仓库代码。
      </div>
    </section>
  );
}
