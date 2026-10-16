import type { ProviderProtocol } from '../../../src/configuration/types';

export function ProviderProtocolSelect({ value, onChange, disabled = false }: {
  value: ProviderProtocol;
  onChange: (value: ProviderProtocol) => void;
  disabled?: boolean;
}) {
  return (
    <label className="settings-field">
      <span>API 协议</span>
      <select className="text-input" value={value} disabled={disabled}
        onChange={event => onChange(event.target.value as ProviderProtocol)}>
        <option value="openai-compatible">OpenAI Chat Completions</option>
        <option value="openai-responses">OpenAI Responses</option>
        <option value="anthropic">Anthropic Messages</option>
      </select>
      <small>{value === 'anthropic'
        ? '按服务商文档选择。填写服务根地址，例如 https://api.anthropic.com；无需追加 /v1/messages。'
        : '按服务商文档选择。填写 API 基础地址，例如 https://api.openai.com/v1；无需追加 /responses 或 /chat/completions。'}</small>
    </label>
  );
}
