import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const notices = ['MetaWork Web third-party software notices\nDocument readers run locally; no document is uploaded to these projects.'];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev || entry.devOptional) continue;
  const directory = resolve(root, path);
  const raw = await readFile(resolve(directory, 'package.json'), 'utf8').catch(error => {
    if (entry.optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) continue;
  const manifest = JSON.parse(raw);
  const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name));
  notices.push(`\n${manifest.name} ${manifest.version}\nLicense: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? entry.license ?? 'See package license')}\n`);
  for (const name of files) notices.push(await readFile(resolve(directory, name), 'utf8'));
}
await mkdir(resolve(root, 'public'), { recursive: true });
await writeFile(resolve(root, 'public/third-party-notices.txt'), notices.join('\n'));
