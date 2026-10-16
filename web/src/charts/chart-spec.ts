/** A presentation-only contract. No ECharts options, executable code or remote resources. */
export interface ChartSpec {
  version: 1;
  type: 'line' | 'bar' | 'area' | 'pie';
  title: string;
  labels: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  xLabel?: string;
  unit?: string;
  source?: string;
}

export type ChartParseResult = { ok: true; spec: ChartSpec } | { ok: false; error: string };

export function parseChartSpec(source: string): ChartParseResult {
  if (source.length > 64_000) return { ok: false, error: '图表数据超过 64,000 字符，请减少数据点。' };
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, error: '图表数据尚不完整或不是有效的 JSON。' }; }
  const fail = (error: string): ChartParseResult => ({ ok: false, error });
  if (!record(value) || !onlyKeys(value, ['version', 'type', 'title', 'labels', 'series', 'xLabel', 'unit', 'source'])) {
    return fail('图表包含不支持的字段。');
  }
  if (value.version !== 1 || !['line', 'bar', 'area', 'pie'].includes(String(value.type))) {
    return fail('仅支持 version 1 的折线图、柱状图、面积图和饼图。');
  }
  if (!text(value.title, 160) || !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 200
    || !value.labels.every(label => text(label, 120))) return fail('需要图表标题和 1–200 个有效分类标签。');
  if (!Array.isArray(value.series) || value.series.length < 1 || value.series.length > 8) return fail('每张图表需要 1–8 组数据。');
  for (const series of value.series) {
    if (!record(series) || !onlyKeys(series, ['name', 'values']) || !text(series.name, 120)
      || !Array.isArray(series.values) || series.values.length !== value.labels.length
      || !series.values.every(point => point === null || (typeof point === 'number' && Number.isFinite(point) && Math.abs(point) <= 1e15))) {
      return fail('每组数据必须具备名称，数值数量与标签一致；缺失值使用 null，数值绝对值不超过 10¹⁵。');
    }
  }
  const series = value.series as ChartSpec['series'];
  if (new Set(series.map(item => item.name)).size !== series.length) return fail('数据组名称不能重复。');
  if (!series.some(item => item.values.some(point => point !== null))) return fail('图表没有可绘制的数值。');
  if (value.type === 'pie' && (series.length !== 1
    || series[0]!.values.some(point => point === null || point < 0)
    || !series[0]!.values.some(point => point !== null && point > 0)
    || new Set(value.labels).size !== value.labels.length)) return fail('饼图需要一组非负数据、唯一标签，且总和大于零。');
  for (const key of ['xLabel', 'unit', 'source'] as const) {
    if (value[key] !== undefined && !text(value[key], key === 'source' ? 1000 : 120)) return fail('坐标名称、单位或数据来源格式不正确。');
  }
  return { ok: true, spec: value as unknown as ChartSpec };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
