import { useCallback, useEffect, useRef, useState } from 'react';

export interface OfficialStatus {
  state: 'logged_out' | 'active' | 'pending_payment' | 'expired' | 'revoked' | 'unavailable';
  account: { email: string; displayName?: string } | null;
  entitlement: { plan: string | null; expiresAt: string | null } | null;
  reason?: string;
}
interface Plan { plan: 'trial' | 'monthly' | 'annual'; amountCny: string; duration: string; payment: string }
const stateLabels = { logged_out: '未登录官方账号', active: '权益有效', pending_payment: '尚未开通权益', expired: '权益已到期', revoked: '权益已撤销', unavailable: '权益待核验' };
const planLabels = { trial: '7 天试用', monthly: '月度订阅', annual: '年度订阅', internal_perpetual: '内部永久权益' };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/official-auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(value?.message ?? '官方账号服务暂时不可用，请稍后重试。');
  return value as T;
}

export function OfficialAccountPanel({ onStatus }: { onStatus: (status: OfficialStatus | null) => void }) {
  const [status, setStatus] = useState<OfficialStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const orderKeys = useRef(new Map<string, string>());
  const refresh = useCallback(async () => {
    try { const value = await request<OfficialStatus>('status'); setStatus(value); onStatus(value); }
    catch { setStatus(null); onStatus(null); }
  }, [onStatus]);
  useEffect(() => {
    void refresh();
    // Only reads the local projection; does not poll the official entitlement service.
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  const open = () => {
    dialog.current?.showModal();
    setError('');
    void request<{ plans: Plan[] }>('plans').then(value => setPlans(value.plans)).catch(cause => setError(cause.message));
  };
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(false); await refresh(); }
  };
  const choosePlan = (plan: Plan) => act(async () => {
    const key = orderKeys.current.get(plan.plan) ?? crypto.randomUUID();
    orderKeys.current.set(plan.plan, key);
    const order = await request<{ orderId: string; status: string; amountCny: string }>('orders', { plan: plan.plan, idempotencyKey: key });
    orderKeys.current.delete(plan.plan);
    setMessage(order.status === 'pending_payment'
      ? `订单 ${order.orderId} 已创建，金额 ¥${order.amountCny}。支付接入尚未开放，当前订单不会开通付费权益。`
      : '7 天试用已开通。');
  });
  const active = status?.state === 'active';
  return <>
    <div className="official-account-bar">
      <span><span className="official-indicator" data-active={active} />{status ? stateLabels[status.state] : '正在确认官方账号状态'}</span>
      <button type="button" onClick={open}>{status?.account ? '账号与订阅' : '登录 / 注册'}</button>
    </div>
    <dialog ref={dialog} className="official-account-dialog" aria-labelledby="official-account-title" onClose={() => setPassword('')}>
      <header><div><small>METAWORK ACCOUNT</small><h2 id="official-account-title">账号与订阅</h2></div><button type="button" aria-label="关闭账号窗口" onClick={() => dialog.current?.close()}>关闭</button></header>
      <p className="official-note">此账号供本机的 Web、Desktop、TUI 和飞书共用。Server 重启后需重新登录；本机历史数据继续保留。</p>
      {!status?.account ? <form onSubmit={event => {
        event.preventDefault();
        void act(async () => {
          if (registering) await request('register', { email, password });
          await request('login', { email, password }); setPassword(''); setRegistering(false); orderKeys.current.clear();
          setMessage('已登录，请选择套餐或刷新现有权益。');
        });
      }}>
        <label htmlFor="official-email">邮箱</label>
        <input id="official-email" type="email" value={email} maxLength={254} required autoComplete="username" onChange={event => setEmail(event.target.value)} />
        <label htmlFor="official-password">密码{registering ? '（12–128 位）' : ''}</label>
        <input id="official-password" type="password" value={password} minLength={registering ? 12 : undefined} maxLength={128} required autoComplete={registering ? 'new-password' : 'current-password'} onChange={event => setPassword(event.target.value)} />
        <div className="official-actions"><button className="primary" disabled={busy} type="submit">{busy ? '处理中…' : registering ? '注册并登录' : '登录'}</button><button disabled={busy} type="button" onClick={() => { setRegistering(!registering); setError(''); }}>{registering ? '已有账号，去登录' : '创建账号'}</button></div>
      </form> : <section className="official-current">
        <strong>{status.account.email}</strong><p>{stateLabels[status.state]} · {status.entitlement?.plan ? planLabels[status.entitlement.plan as keyof typeof planLabels] : '未选择套餐'}</p>
        {status.entitlement?.expiresAt && <p>到期时间：{new Date(status.entitlement.expiresAt).toLocaleString()}</p>}
        <div className="official-actions"><button type="button" disabled={busy} onClick={() => void act(async () => { await request('verify', {}); setMessage('核验已完成，请查看当前权益状态。'); })}>刷新权益</button><button type="button" disabled={busy} onClick={() => void act(async () => { await request('logout', {}); orderKeys.current.clear(); setMessage('已退出。新增工作已暂停，正在执行的工作将安全收尾。'); })}>退出账号</button></div>
      </section>}
      <section aria-label="订阅套餐" className="official-plans">
        {plans.map(plan => <article key={plan.plan}><h3>{planLabels[plan.plan]}</h3><p className="official-price">¥{plan.amountCny}<small> / {plan.duration}</small></p><p>{plan.plan === 'trial' ? '每个账号仅可开通一次' : '支付接入准备中'}</p><button type="button" disabled={!status?.account || busy || (plan.plan === 'trial' && Boolean(status?.entitlement?.plan))} onClick={() => void choosePlan(plan)}>{plan.plan === 'trial' ? status?.entitlement?.plan ? '试用不可重复开通' : '开通试用' : '创建待支付订单'}</button></article>)}
      </section>
      {error && <p role="alert" className="official-error">{error}</p>}
      {message && <p role="status" className="official-message">{message}</p>}
      {status?.reason && <p className="official-note">{status.reason}</p>}
      <footer>订阅包含软件使用权及合理额度的 MetaWork 内置 AI；Planner / Executor 的模型费用另计。使用内置 AI 时，仅当前操作所需文本及模型公开资料会发送至官方服务及其模型供应商。官方不记录输入正文；用量元数据保留 30 天。</footer>
    </dialog>
  </>;
}
