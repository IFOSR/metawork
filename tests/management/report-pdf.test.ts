import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createReportPdf, reportPdfName } from '../../src/management/report-pdf.js';

async function readPdf(bytes: Buffer) {
  const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const text = await page.getTextContent();
      pages.push(text.items.map(item => 'str' in item ? item.str : '').join(''));
    }
    return pages;
  } finally { await document.destroy(); }
}

describe('local report PDF', () => {
  it('embeds searchable Chinese and paginates tables with repeated headers without losing the final row', async () => {
    const rows = Array.from({ length: 110 }, (_, i) => `| 项目${i + 1} | **增长** ${i + 1}% |`).join('\n');
    const pdf = await createReportPdf(`# 季度研究报告\n\n中文正文 &amp; English。\n\n| 指标名称 | 变化情况 |\n|---|---:|\n${rows}\n\n## 结论\n\n最后一段完整保留。`, '季度研究报告.md');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = await readPdf(pdf);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join('')).toContain('中文正文 & English。');
    expect(pages.filter(page => page.includes('指标名称')).length).toBeGreaterThan(2);
    expect(pages.join('')).toContain('项目110');
    expect(pages.join('')).toContain('最后一段完整保留。');
    expect(pages.at(-1)).toContain(`${pages.length} / ${pages.length}`);
  });

  it('retains nested lists, code, literal punctuation, safe links and image captions', async () => {
    const pdf = await createReportPdf('## 说明\n\n> 引用说明\n\n3. 首项\n   - 嵌套列表\n4. 末项\n\n```js\nconst text = "<中文> &amp;";\n```\n\n[来源](https://example.com) ![远程图表](https://example.com/chart.png)\n\n---\n\n收尾。', '说明.md');
    const text = (await readPdf(pdf)).join('');
    for (const value of ['引用说明', '嵌套列表', '末项', '<中文> &amp;', '来源', '远程图表', '收尾。']) expect(text).toContain(value);
  });

  it('embeds resolved PNG illustrations and handles an empty report', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const pdf = await createReportPdf('# 图表\n\n![测试图](chart.png)\n\n结束。', '图表.md', async () => png);
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    expect((await readPdf(pdf)).join('')).toContain('结束。');
    expect(await readPdf(await createReportPdf('', '空白.md'))).toHaveLength(1);
    expect(reportPdfName('报告.MARKDOWN')).toBe('报告.pdf');
  });
});
