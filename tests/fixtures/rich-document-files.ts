import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const JSZip = webRequire('jszip') as typeof import('../../web/node_modules/jszip');
const ExcelJS = webRequire('exceljs') as typeof import('../../web/node_modules/exceljs');
const XLSX = webRequire('xlsx') as typeof import('../../web/node_modules/xlsx');

const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

/** Small real OOXML files; generated in memory, with no external office installation or user data. */
export async function richDocumentFiles(): Promise<Record<string, Buffer>> {
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file('_rels/.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`);
  docx.file('word/_rels/document.xml.rels', `<Relationships xmlns="${relationships}"><Relationship Id="image1" Type="${office}/image" Target="media/image1.png"/></Relationships>`);
  docx.file('word/media/image1.png', png);
  docx.file('word/document.xml', `<w:document xmlns:w="${word}" xmlns:r="${office}" xmlns:a="${drawing}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
    <w:p><w:r><w:rPr><w:b/><w:color w:val="2456A6"/><w:sz w:val="36"/></w:rPr><w:t>企业主权 AI 文档预览</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>中文表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="示例图片"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:br w:type="page"/><w:t>第二页交付说明</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`);
  const pptx = new JSZip();
  pptx.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${[1, 2, 3].map(i => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`);
  pptx.file('_rels/.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  pptx.file('ppt/presentation.xml', `<p:presentation xmlns:p="${presentation}" xmlns:r="${office}"><p:sldIdLst>${[1, 2, 3].map(i => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  pptx.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${relationships}">${[1, 2, 3].map(i => `<Relationship Id="rId${i}" Type="${office}/slide" Target="slides/slide${i}.xml"/>`).join('')}</Relationships>`);
  pptx.file('ppt/media/image1.png', png);
  for (const i of [1, 2, 3]) {
    pptx.file(`ppt/slides/_rels/slide${i}.xml.rels`, `<Relationships xmlns="${relationships}"><Relationship Id="image1" Type="${office}/image" Target="../media/image1.png"/></Relationships>`);
    pptx.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${office}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="EFF5FF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800" b="1"><a:solidFill><a:srgbClr val="2456A6"/></a:solidFill></a:rPr><a:t>商业宣讲第 ${i} 页</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="3" name="示例图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="2000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
      </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  }
  const excel = new ExcelJS.Workbook();
  const sales = excel.addWorksheet('销售汇总'); sales.mergeCells('A1:C1'); sales.getCell('A1').value = '商业化收入';
  sales.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 18 };
  sales.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2456A6' } };
  sales.addRow(['产品', '数量', '售价']); sales.addRow(['企业版', 2, 1234.5]); sales.getCell('C3').numFmt = '"¥"#,##0.00';
  sales.getCell('C4').value = { formula: 'B3*C3', result: 2469 };
  excel.addWorksheet('定价明细').addRow(['基础版', '每月 99 元']);
  const legacy = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(legacy, XLSX.utils.aoa_to_sheet([['旧版表格', 123]]), '历史数据');
  const html = '<!doctype html><html><head><style>body{font-family:sans-serif;padding:24px}h1{color:rgb(36,86,166)}table{border-collapse:collapse}td{border:1px solid;padding:10px}</style></head><body><h1>HTML 商业报告</h1><table><tr><td>收入</td><td>¥1,234</td></tr></table><img src="data:image/png;base64,' + png.toString('base64') + '"><script>parent.parent.document.body.dataset.previewEscaped="yes";fetch("/should-not-request")</script><img src="https://example.invalid/should-not-request" onerror="parent.postMessage(\'escape\',\'*\')"></body></html>';
  return {
    'report.docx': await docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    'slides.pptx': await pptx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    'sales.xlsx': Buffer.from(await excel.xlsx.writeBuffer()),
    'legacy.xls': XLSX.write(legacy, { type: 'buffer', bookType: 'biff8' }),
    'data.csv': Buffer.from('产品,金额\n企业版,1234\n'),
    'report.html': Buffer.from(html.replace('</body>', '<img alt="本地图示" src="图示.png"></body>')),
    '图示.png': png,
    'broken.docx': Buffer.from('not an office archive'),
    'report.pdf': samplePdf(),
  };
}

function samplePdf(): Buffer {
  const text = 'BT /F1 24 Tf 40 180 Td (MetaWork PDF Preview) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 250] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
