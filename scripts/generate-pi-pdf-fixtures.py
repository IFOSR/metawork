import sys,json
from pathlib import Path
sys.path.insert(0,str(Path('dist/pi-pdf/site-packages').resolve()))
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter,PdfReader
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
root=Path(sys.argv[1] if len(sys.argv)>1 else '.tmp/pdf-acceptance');root.mkdir(parents=True,exist_ok=True)
# Optional font argument supports a CJK font on other smoke hosts.
font=ImageFont.truetype(sys.argv[2] if len(sys.argv)>2 else '/System/Library/Fonts/Supplemental/Songti.ttc',44)
im=Image.new('RGB',(1200,900),'white');d=ImageDraw.Draw(im)
for i,line in enumerate(['合成测试发票','Invoice No: TEST-739281','开票日期：2026-09-18','购买项目：办公用品','金额：128.60 元']): d.text((70,80+i*120),line,fill='black',font=font)
im.save(root/'scan.png');im.save(root/'scan.pdf','PDF',resolution=110)
w=PdfWriter();p=w.add_blank_page(width=600,height=800);stream=DecodedStreamObject();stream.set_data(b'BT /F1 20 Tf 50 700 Td (Invoice TEST-462913 Amount CNY 72.35 Date 2026-09-20) Tj ET')
f=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(f)})});p[NameObject('/Contents')]=w._add_object(stream)
w.write(root/'text.pdf')
m=PdfWriter();m.append(root/'text.pdf');m.append(root/'scan.pdf');m.write(root/'mixed.pdf')
w.encrypt('synthetic-password');w.write(root/'encrypted.pdf')
(root/'broken.pdf').write_bytes(b'%PDF-1.7\nnot-a-document')
many=PdfWriter()
for _ in range(6):many.append(root/'text.pdf')
many.write(root/'six-pages.pdf')
(root/'expected.json').write_text(json.dumps({'requiredText':['TEST-462913','TEST-739281','72.35','128.60','200.95']}))
print('Synthetic PDF fixtures ready')

# Simple ruled table exercises pdfplumber's structural extraction, not OCR.
t=PdfWriter();page=t.add_blank_page(width=400,height=700)
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):t._add_object(f)})})
stream=DecodedStreamObject();stream.set_data(b'1 w 50 500 m 300 500 l S 50 540 m 300 540 l S 50 580 m 300 580 l S 50 500 m 50 580 l S 180 500 m 180 580 l S 300 500 m 300 580 l S BT /F1 12 Tf 60 554 Td (Item) Tj ET BT /F1 12 Tf 190 554 Td (Amount) Tj ET BT /F1 12 Tf 60 514 Td (Test) Tj ET BT /F1 12 Tf 190 514 Td (10.00) Tj ET')
page[NameObject('/Contents')]=t._add_object(stream);t.write(root/'table.pdf')
