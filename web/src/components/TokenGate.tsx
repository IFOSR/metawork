import { useState } from 'react';

interface TokenGateProps {
  error?: string | null;
  onLogin: (username: string, password: string) => Promise<boolean>;
  onTokenAuth: (token: string) => Promise<boolean>;
}

export function TokenGate({ error, onLogin, onTokenAuth }: TokenGateProps) {
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const submitPassword = () => {
    if (!username.trim() || !password || loading) return;
    setLoading(true);
    void onLogin(username.trim(), password).finally(() => setLoading(false));
  };

  const submitToken = () => {
    const trimmed = token.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    void onTokenAuth(trimmed).finally(() => setLoading(false));
  };

  return (
    <div className="token-gate">
      <form
        className="token-gate-card"
        onSubmit={event => {
          event.preventDefault();
          if (mode === 'password') submitPassword();
          else submitToken();
        }}
      >
        <h1>MetaWork</h1>
        {mode === 'password' ? (
          <>
            <p>请使用系统分配的账号密码登录。</p>
            {error && <div className="result-banner result-error">{error}</div>}
            <input
              type="text"
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="用户名"
              autoComplete="username"
              autoFocus
            />
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
            <button type="submit" disabled={loading}>
              {loading ? '登录中…' : '登录'}
            </button>
            <button
              type="button"
              className="login-mode-switch"
              onClick={() => setMode('token')}
            >
              使用访问令牌登录
            </button>
          </>
        ) : (
          <>
            <p>
              请粘贴 <span className="mono">metawork web --no-open</span>
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
            <button type="submit" disabled={loading}>
              {loading ? '验证中…' : '进入'}
            </button>
            <button
              type="button"
              className="login-mode-switch"
              onClick={() => setMode('password')}
            >
              返回账号密码登录
            </button>
          </>
        )}
      </form>
    </div>
  );
}
