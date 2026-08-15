import { useState } from 'react';

interface TokenGateProps {
  onAuth: (token: string, trust: boolean) => void;
}

export function TokenGate({ onAuth }: TokenGateProps) {
  const [token, setToken] = useState('');
  const [trust, setTrust] = useState(false);

  return (
    <div className="token-gate">
      <form
        className="token-gate-card"
        onSubmit={event => {
          event.preventDefault();
          const trimmed = token.trim();
          if (!trimmed) return;
          onAuth(trimmed, trust);
        }}
      >
        <h1>AnyFusion</h1>
        <p>粘贴终端里打印的访问 token。</p>
        <input
          type="password"
          value={token}
          onChange={event => setToken(event.target.value)}
          placeholder="token"
          autoFocus
        />
        <label className="trust-row">
          <input
            type="checkbox"
            checked={trust}
            onChange={event => setTrust(event.target.checked)}
          />
          信任本机（下次免输入）
        </label>
        <button type="submit">进入</button>
      </form>
    </div>
  );
}
