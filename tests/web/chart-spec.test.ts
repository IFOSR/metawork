import { describe, expect, it } from 'vitest';
import { parseChartSpec } from '../../web/src/charts/chart-spec';

const spec = { version: 1, type: 'line', title: '季度收入', labels: ['Q1', 'Q2', 'Q3'],
  series: [{ name: '实际', values: [-1, null, 3] }], unit: '万元', source: '测试数据' };
const parse = (overrides: Record<string, unknown> = {}) => parseChartSpec(JSON.stringify({ ...spec, ...overrides }));

describe('inline chart data boundary', () => {
  it.each(['line', 'bar', 'area'])('preserves gaps and negative values in %s', type => {
    expect(parse({ type })).toEqual({ ok: true, spec: { ...spec, type } });
  });
  it('accepts a part-to-whole pie and rejects misleading pie data', () => {
    expect(parse({ type: 'pie', series: [{ name: '销售', values: [0, 1, 2] }] }).ok).toBe(true);
    for (const values of [[-1, 2, 3], [0, 0, 0], [1, null, 3]]) {
      expect(parse({ type: 'pie', series: [{ name: '销售', values }] }).ok).toBe(false);
    }
    expect(parse({ type: 'pie', labels: ['Q1', 'Q1', 'Q3'] }).ok).toBe(false);
  });
  it.each([
    { version: 2 }, { type: 'javascript' }, { title: '' }, { series: [] },
    { labels: Array(201).fill('x') }, { labels: ['a'] }, { series: [{ name: 'a', values: ['1', 2, 3] }] },
    { series: [{ name: 'a', values: [null, null, null] }] },
    { series: [{ name: 'a', values: [1e16, 2, 3] }] },
    { series: Array(9).fill(spec.series[0]) }, { series: [spec.series[0], spec.series[0]] },
    { tooltip: { formatter: 'alert(1)' } }, { url: 'https://untrusted.invalid/data' },
    { series: [{ name: 'a', values: [1, 2, 3], itemStyle: { image: 'http://untrusted.invalid' } }] },
    { source: { url: 'http://untrusted.invalid' } },
  ])('rejects invalid shape or executable renderer options: %j', overrides => {
    expect(parse(overrides).ok).toBe(false);
  });
  it('handles malformed, incomplete, huge and nonfinite JSON without throwing', () => {
    for (const raw of ['null', '[]', '{"version":', 'a'.repeat(64_001), JSON.stringify(spec).replace('-1', '1e999')]) {
      expect(parseChartSpec(raw).ok).toBe(false);
    }
  });
});
