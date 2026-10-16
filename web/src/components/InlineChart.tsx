import { useEffect, useMemo, useState } from 'react';
import { parseChartSpec } from '../charts/chart-spec';
import type { ChartView } from '../charts/ChartView';

export function InlineChart({ source }: { source: string }) {
  const parsed = useMemo(() => parseChartSpec(source), [source]);
  const [Renderer, setRenderer] = useState<typeof ChartView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!parsed.ok) return;
    let active = true;
    setError(undefined);
    void import('../charts/ChartView').then(module => {
      if (active) setRenderer(() => module.ChartView);
    }).catch(() => { if (active) setError('图表组件加载失败，请刷新后重试。'); });
    return () => { active = false; };
  }, [parsed]);
  if (!parsed.ok) return <div className="inline-chart-fallback" role="note">
    <p>暂时无法绘制图表：{parsed.error}</p>
    <details><summary>查看原始图表数据</summary><pre><code>{source}</code></pre></details>
  </div>;
  const { spec } = parsed;
  return <figure className="inline-chart" aria-label={spec.title}>
    <figcaption><strong>{spec.title}</strong>{spec.unit && <span>单位：{spec.unit}</span>}</figcaption>
    {error ? <p role="status">{error} 下方数据仍可查看。</p>
      : Renderer ? <Renderer spec={spec} onError={setError} /> : <p role="status">正在绘制图表…</p>}
    {spec.source && <p className="inline-chart-source">数据来源：{spec.source}</p>}
    <details className="inline-chart-data">
      <summary>查看数据（{spec.labels.length} 项）</summary>
      <div className="markdown-table-scroll" role="region" aria-label={`${spec.title}数据表`} tabIndex={0}>
        <table><caption>{spec.title}{spec.unit ? `（${spec.unit}）` : ''}</caption>
          <thead><tr><th scope="col">{spec.xLabel || '分类'}</th>{spec.series.map(series => <th scope="col" key={series.name}>{series.name}</th>)}</tr></thead>
          <tbody>{spec.labels.map((label, index) => <tr key={index}><th scope="row">{label}</th>
            {spec.series.map(series => <td className="chart-number" key={series.name}>{series.values[index] === null ? '缺失' : String(series.values[index])}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </figure>;
}
