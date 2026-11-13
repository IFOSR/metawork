import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const ExcelJS = webRequire('exceljs') as typeof import('../../web/node_modules/exceljs');
const JSZip = webRequire('jszip') as typeof import('../../web/node_modules/jszip');

describe('spreadsheet preview dependency compatibility', () => {
  it('round-trips an XLSX with extended conditional formatting and distinct UUIDs', async () => {
    // ExcelJS uses the overridden UUID v4 API when writing extended rules.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('用量');
    sheet.addRows([['模型', 'Token'], ['官方模型', 21], ['自备模型', 5]]);
    for (const ref of ['B2:B3', 'B2']) sheet.addConditionalFormatting({
      ref, rules: [{ type: 'dataBar', priority: 1, gradient: false,
        cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF7799AA' } }],
    });
    const bytes = await workbook.xlsx.writeBuffer();
    const archive = await JSZip.loadAsync(bytes);
    const xml = await archive.file('xl/worksheets/sheet1.xml')!.async('string');
    const ids = [...xml.matchAll(/<x14:cfRule[^>]*id="\{([A-F0-9-]+)\}"/gu)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/u);
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(bytes);
    expect(restored.getWorksheet('用量')?.getCell('B2').value).toBe(21);
    expect(restored.getWorksheet('用量')?.getCell('A3').value).toBe('自备模型');
    expect(restored.getWorksheet('用量')?.conditionalFormattings).toHaveLength(2);
  });
});
