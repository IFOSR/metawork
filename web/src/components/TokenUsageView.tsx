import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { TokenUsageView as UsageView } from '../../../src/management/token-usage-management';
import type { UsageTimelineRequest } from '../../../src/metering/token-usage-timeline';

const periods = [['today', '今天'], ['week', '本周'], ['7days', '近 7 天'], ['30days', '近 30 天'],
  ['month', '本月'], ['lastMonth', '上月'], ['subscription', '本订阅周期'], ['custom', '自定义']] as const;
const colors = ['#6a94c7', '#77a58c', '#b69465', '#9a83b5', '#bf7d79', '#6da9b0'];
const format = (value: string | number) => BigInt(value).toLocaleString('zh-CN');
// BigInt ratios keep arbitrarily large counters finite and exact until rendering pixels.
const percentage = (value: bigint, maximum: bigint) => maximum === 0n ? 0 : Number(value * 10000n / maximum) / 100;

export function TokenUsageView({ http }: { http: HttpClient }) {
  const [query, setQuery] = useState<UsageTimelineRequest>({ period: '7days', groupBy: 'model' });
  const [dates, setDates] = useState({ start: '', end: '' });
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null); setHidden(new Set());
    void http.getTokenUsageTimeline(query, controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(() => {
      if (!controller.signal.aborted) setError('无法读取用量，请检查连接后重试。自定义日期最多支持 366 天。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [http, query, revision]);
  const visible = data?.series.filter(series => !hidden.has(series.id)) ?? [];
  const dailyTotals = data?.days.map(day => visible.reduce((sum, series) => sum + BigInt(day.values[series.id] ?? '0'), 0n)) ?? [];
  const maximum = dailyTotals.reduce((max, value) => value > max ? value : max, 0n);
  const selectPeriod = (period: string) => {
    if (period === 'custom') {
      const start = data?.range.start ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const end = data?.range.end ?? start;
      setDates({ start, end }); setQuery({ period, groupBy: query.groupBy, start, end });
    } else setQuery({ period, groupBy: query.groupBy });
  };
  return <section className="usage-workspace" aria-label="账号 Token 用量">
    <header className="usage-heading">
      <div><span className="workspace-kicker">ACCOUNT USAGE</span><h2>用量</h2><p>当前账号全部会话 · 北京时间 UTC+8</p></div>
      <button className="ghost-button" onClick={() => setRevision(value => value + 1)} disabled={loading}>刷新</button>
    </header>
    <div className="usage-controls">
      <label>时间区间<select value={query.period} onChange={event => selectPeriod(event.target.value)}>
        {periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Group By<select value={query.groupBy} onChange={event => setQuery({ ...query, groupBy: event.target.value })}>
        <option value="model">按模型</option><option value="provider">按 Provider</option>
      </select></label>
      {query.period === 'custom' && <form className="usage-dates" onSubmit={event => {
        event.preventDefault(); setQuery({ ...query, ...dates });
      }}>
        <label>开始日期<input type="date" required value={dates.start} max={dates.end || undefined} onChange={event => setDates({ ...dates, start: event.target.value })} /></label>
        <label>结束日期<input type="date" required value={dates.end} min={dates.start || undefined} onChange={event => setDates({ ...dates, end: event.target.value })} /></label>
        <button type="submit">应用日期</button>
      </form>}
    </div>
    {loading && <p role="status">正在读取用量…</p>}
    {error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {data && <>
      <p className="usage-range">{data.range.start} — {data.range.end} · 输入 + 输出 Token</p>
      <div className="usage-summary">
        {([['Total tokens', data.totals.totalTokens, '全部已记录用量'], ['Included', data.totals.includedTokens, 'MetaWork 官方额度'],
          ['On-demand', data.totals.onDemandTokens, '自备 Provider · 不占官方额度']] as const).map(([title, value, description]) =>
          <section key={title}><h3>{title}</h3><strong>{format(value)}</strong><span>{description}</span></section>)}
      </div>
      {data.totals.missingCalls > 0 && <p className="usage-notice" role="status">{data.totals.missingCalls} 次调用缺少完整用量，当前合计仅包含已记录 Token。</p>}
      {data.totals.unattributedCalls > 0 && <p className="usage-notice">归属未知：{format(data.totals.unattributedTokens)} Token（{data.totals.unattributedCalls} 次调用），计入总量，未计入 Included 或 On-demand。</p>}
      <section className="usage-chart-panel" aria-label="按天用量趋势">
        <header><h3>每日用量</h3><span>当前可见峰值 {format(maximum.toString())}</span></header>
        {data.totals.calls === 0 ? <p className="usage-empty">这段时间还没有用量记录。</p> : <>
          <div className="usage-chart-scroll" tabIndex={0} aria-label="可横向滚动的每日堆叠柱状图">
            <div className="usage-chart" style={{ minWidth: Math.max(280, data.days.length * 34) }}>
              {data.days.map((day, index) => <div className="usage-chart-day" key={day.date}>
                <div className="usage-bar" role="img" aria-label={`${day.date}，可见 ${format(dailyTotals[index].toString())} Token`}>
                  {data.series.map((series, seriesIndex) => !hidden.has(series.id) && <span key={series.id}
                    title={`${day.date} · ${series.label}: ${format(day.values[series.id] ?? '0')} Token`}
                    style={{ height: `${percentage(BigInt(day.values[series.id] ?? '0'), maximum)}%`, background: colors[seriesIndex % colors.length] }} />)}
                </div><span className="usage-day-label">{day.date.slice(5)}</span>
              </div>)}
            </div>
          </div>
          <div className="usage-legend" aria-label="点击显示或隐藏系列">
            {data.series.map((series, index) => <button key={series.id} aria-pressed={!hidden.has(series.id)} onClick={() => setHidden(previous => {
              const next = new Set(previous); if (next.has(series.id)) next.delete(series.id); else next.add(series.id); return next;
            })}><i aria-hidden="true" style={{ background: colors[index % colors.length] }} /><span>{series.label}</span><strong>{format(series.tokens)}</strong></button>)}
          </div>
          <details className="usage-table"><summary>查看每日数据</summary><div className="usage-table-scroll"><table>
            <caption>完整记录，不受图例隐藏影响</caption><thead><tr><th>日期</th><th>Total tokens</th><th>Included</th><th>On-demand</th><th>归属未知</th><th>缺失调用</th></tr></thead>
            <tbody>{data.days.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{format(day.totalTokens)}</td><td>{format(day.includedTokens)}</td><td>{format(day.onDemandTokens)}</td><td>{format(day.unattributedTokens)}</td><td>{day.missingCalls}</td></tr>)}</tbody>
          </table></div></details>
        </>}
      </section>
      {data.quota.providers.length > 0 && (
        <aside className="usage-quota" aria-label="第三方供应商">
          <h3>第三方供应商</h3>
          <p>额度用尽或需要其它模型时，可直接使用下列供应商，它们由各自账户独立计费。</p>
          <div className="quota-guidance-list">
            {data.quota.providers.map(provider => <a key={provider.id}
              href={/^https?:\/\//u.test(provider.url) ? provider.url : undefined} target="_blank" rel="noreferrer">
              {provider.logoUrl
                ? <img className="provider-logo" src={provider.logoUrl} alt="" width={28} height={28} loading="lazy" />
                : null}
              <span><strong>{provider.name}</strong><small>{provider.description}</small></span>
              <span aria-hidden="true">↗</span>
            </a>)}
          </div>
        </aside>
      )}
    </>}
  </section>;
}
