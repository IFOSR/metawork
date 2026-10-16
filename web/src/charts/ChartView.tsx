import { useEffect, useRef, useState } from 'react';
import { init, use, type EChartsType, type EChartsCoreOption } from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { ChartSpec } from './chart-spec';
import { desktopBridge } from '../platform/services';

use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);

const colors = ['#5b8def', '#d88b37', '#3ca38d', '#b27bce', '#dd697a', '#62a7bc', '#8c9850', '#9d8a7b'];

export function ChartView({ spec, onError }: { spec: ChartSpec; onError: (error: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType>();
  const [hidden, setHidden] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const desktop = desktopBridge();
  const labels = spec.type === 'pie' ? spec.labels : spec.series.map(series => series.name);
  useEffect(() => {
    if (!root.current) return;
    const element = root.current;
    let instance: EChartsType | undefined;
    const draw = () => {
      try {
        instance ??= init(element, undefined, { renderer: 'svg' });
        chart.current = instance;
        const css = getComputedStyle(element);
        const text = css.getPropertyValue('--text').trim() || '#333';
        const border = css.getPropertyValue('--border').trim() || '#ddd';
        const background = css.getPropertyValue('--bg-panel').trim() || '#fff';
        const series = spec.type === 'pie' ? [{
          type: 'pie', radius: ['30%', '64%'], center: ['50%', '48%'],
          label: { show: false },
          data: spec.labels.flatMap((name, index) => hidden.includes(name) ? [] : [{ name, value: spec.series[0]!.values[index], itemStyle: { color: colors[index % colors.length] } }]),
        }] : spec.series.map((item, index) => ({
          name: item.name, type: spec.type === 'bar' ? 'bar' : 'line',
          data: hidden.includes(item.name) ? [] : item.values,
          itemStyle: { color: colors[index % colors.length] },
          lineStyle: { width: 2 }, symbolSize: 7, connectNulls: false,
          ...(spec.type === 'area' ? { areaStyle: { opacity: 0.18 } } : {}),
          emphasis: { focus: 'series' },
        }));
        const option: EChartsCoreOption = {
          animation: false, color: colors, textStyle: { color: text, fontFamily: css.fontFamily },
          aria: { enabled: true, label: { description: `${spec.title}。可通过下方“查看数据”阅读所有数值；缺失值不代表零。` },
            decal: { show: spec.type === 'pie' || spec.type === 'bar' } },
          tooltip: { trigger: spec.type === 'pie' ? 'item' : 'axis', renderMode: 'richText', confine: true,
            backgroundColor: background, borderColor: border, textStyle: { color: text } },
          grid: { left: 12, right: 20, top: 28, bottom: 32, containLabel: true },
          ...(spec.type === 'pie' ? {} : {
            xAxis: { type: 'category', data: spec.labels, name: spec.xLabel, nameLocation: 'middle', nameGap: 28,
              axisLabel: { color: text, width: 90, overflow: 'truncate', hideOverlap: true }, axisLine: { lineStyle: { color: border } } },
            yAxis: { type: 'value', axisLabel: { color: text }, splitLine: { lineStyle: { color: border } } },
          }),
          series,
        };
        instance.setOption(option, { notMerge: true });
        instance.resize();
      } catch { onError('图表绘制失败。'); }
    };
    draw();
    const resize = new ResizeObserver(() => instance?.resize()); resize.observe(element);
    const theme = new MutationObserver(draw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => { resize.disconnect(); theme.disconnect(); instance?.dispose(); chart.current = undefined; };
  }, [spec, hidden, onError]);

  const save = async () => {
    if (!chart.current) return;
    setSaving(true); setSaveError(undefined);
    try {
      chart.current.dispatchAction({ type: 'hideTip' });
      const rendered = root.current?.querySelector('svg');
      if (!rendered) throw new Error('chart unavailable');
      // Serialize the rendered DOM: the renderer's string exporter does not
      // escape quotes in font-family attributes and can emit invalid XML.
      const snapshot = rendered.cloneNode(true) as SVGSVGElement;
      snapshot.setAttribute('width', String(chart.current.getWidth()));
      snapshot.setAttribute('height', String(chart.current.getHeight()));
      const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      background.setAttribute('width', '100%'); background.setAttribute('height', '100%');
      background.setAttribute('fill', getComputedStyle(root.current!).getPropertyValue('--bg-panel').trim() || '#fff');
      snapshot.prepend(background);
      const svg = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(new XMLSerializer().serializeToString(snapshot))}`;
      if (desktop) {
        if (!desktop.saveChartImage) { setSaveError('请更新桌面应用后保存图表。'); return; }
        const image = new Image(); image.src = svg; await image.decode();
        const canvas = document.createElement('canvas');
        const scale = Math.min(2, 4096 / image.width, 4096 / image.height, Math.sqrt(8_000_000 / (image.width * image.height)));
        canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d'); if (!context) throw new Error('canvas unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setDownloadId(await desktop.saveChartImage(spec.title, canvas.toDataURL('image/png')));
        return;
      }
      // ECharts creates SVG locally from validated data; no user markup or external assets.
      const link = document.createElement('a');
      link.href = svg;
      link.download = `${spec.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'chart'}.svg`;
      document.body.append(link); link.click(); link.remove();
    } catch { setSaveError('图表保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  return <>
    <div className="inline-chart-controls">
      <div className="inline-chart-legend" aria-label="图例">
        {labels.map((label, index) => <button type="button" key={label} aria-pressed={!hidden.includes(label)}
          onClick={() => setHidden(previous => previous.includes(label) ? previous.filter(name => name !== label) : [...previous, label])}>
          <span style={{ backgroundColor: colors[index % colors.length] }} aria-hidden="true" />{label}
        </button>)}
      </div>
      <button type="button" className="ghost-button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : desktop ? '保存图表 PNG' : '下载 SVG'}</button>
    </div>
    {saveError && <p role="alert">{saveError}</p>}
    {downloadId && <button type="button" className="ghost-button" onClick={() => void desktop?.showDownloadedArtifact(downloadId).catch(() => setSaveError('文件位置不可用。'))}>在 Finder 中显示</button>}
    <div className="inline-chart-plot" ref={root} role="img" aria-label={`${spec.title}。可通过下方“查看数据”阅读所有数值。`} />
  </>;
}
