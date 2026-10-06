import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import assert from 'node:assert/strict';import {writeFile,open,symlink,mkdir,rm} from 'node:fs/promises';
const packageRoot=process.env.METAWORK_PI_PACKAGE_ROOT;
if(!packageRoot)throw new Error('Set METAWORK_PI_PACKAGE_ROOT to the installed system Pi package (not the vendored Planner).');
const core=resolve(packageRoot,'dist/core')+'/';
const {loadExtensions}=await import(pathToFileURL(core+'extensions/loader.js'));
const {createEventBus}=await import(pathToFileURL(core+'event-bus.js'));
const root=resolve(process.argv[2]||'.tmp/pdf-acceptance');
const loaded=await loadExtensions([resolve('dist/pi-pdf/index.ts')],root,createEventBus());
assert.deepEqual(loaded.errors,[]);
const tools=loaded.extensions[0].tools;
console.log('Loaded existing Pi PDF tools:',[...tools.keys()]);
const outcomes=[];
async function run(name,args){const registered=tools.get(name);return registered.definition.execute('check',args,new AbortController().signal,()=>{}, {cwd:root});}
assert.equal((await run('pdf_info',{path:'mixed.pdf'})).details.pages,2);
assert.match((await run('pdf_extract_text',{path:'text.pdf'})).content[0].text,/TEST-462913/);
assert.equal((await run('pdf_extract_text',{path:'scan.pdf'})).details.pages[0].text,'');
for(const args of [{path:'broken.pdf'},{path:'encrypted.pdf'},{path:'six-pages.pdf'},{path:'text.pdf',pages:'20'}]){
 await assert.rejects(()=>run('pdf_extract_text',args));outcomes.push({args,rejected:true});
}
const oversized=await open(root+'/oversized.pdf','w');await oversized.truncate(50*1024*1024+1);await oversized.close();
try { await assert.rejects(()=>run('pdf_info',{path:'oversized.pdf'}),/50 MiB/); }
finally { await rm(root+'/oversized.pdf'); }
const table=await run('pdf_extract_tables',{path:'table.pdf'});
assert.deepEqual(table.details.tables[0].rows,[['Item','Amount'],['Test','10.00']]);
const rendered=await run('pdf_to_images',{path:'mixed.pdf',pages:'2',output_dir:'bounded-pages'});
const payload=JSON.parse(rendered.content[0].text);assert.equal(payload.pages.length,1);assert.equal(payload.pages[0].page,2);
await assert.rejects(()=>run('pdf_to_images',{path:'scan.pdf',output_dir:'../escaped-images'}));
await writeFile(root+'/extension-check.json',JSON.stringify({passed:true,tools:[...tools.keys()],outcomes,pageSelection:true,scanTextEmpty:true,outputBoundary:true,inputByteLimit:true,tableExtraction:true},null,2));
console.log('PDF text/scanned/mixed/encrypted/corrupt/range and output-boundary checks passed.');
