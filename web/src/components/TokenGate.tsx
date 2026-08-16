import { useState } from 'react';

interface TokenGateProps {
  error?: string | null;
  onAuth: (token: string) => Promise<boolean>;
}

export function TokenGate({ error, onAuth }: TokenGateProps) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  return (
    <div className="token-gate">
      <form
        className="token-gate-card"
        onSubmit={event => {
          event.preventDefault();
          const trimmed = token.trim();
          if (!trimmed || loading) return;
          setLoading(true);
          void onAuth(trimmed).finally(() => setLoading(false));
        }}
      >
        <h1>AnyFusion</h1>
        <p>
          自动登录不可用。请粘贴 <span className="mono">anyfusion web --no-open</span>
          终端中显示的本机访问 token。它不是模型 API Key。
        </p>
        {error && <div className="result-banner result-error">{error}</div>}
        <input
          type="password"
          value={token}
          onChange={event => setToken(event.target.value)}
          placeholder="Web access token"
          autoFocus
        />
        <button type="submit" disabled={loading}>{loading ? '验证中…' : '进入'}</button>
      </form>
    </div>
  );
}
