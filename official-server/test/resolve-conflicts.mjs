import fs from 'node:fs';

// mode: 'union' = keep both sides; 'ours' = keep HEAD side only
function resolve(file, mode) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
  const out = [];
  let state = 'normal';
  let ours = [], theirs = [], blocks = 0;
  for (const line of lines) {
    if (state === 'normal') {
      if (line.startsWith('<<<<<<<')) { state = 'ours'; ours = []; theirs = []; }
      else out.push(line);
    } else if (state === 'ours') {
      if (line.startsWith('=======')) state = 'theirs';
      else ours.push(line);
    } else {
      if (line.startsWith('>>>>>>>')) {
        blocks++;
        out.push(...(mode === 'union' ? [...ours, ...theirs] : ours));
        state = 'normal';
      } else theirs.push(line);
    }
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(`${file}: ${blocks} blocks resolved (${mode}), markers left: ${out.some(l => l.startsWith('<<<<<<<')) ? 'STILL' : 0}`);
}

resolve('web/package.json', 'union');
resolve('docs/current/technical-overview.md', 'union');
resolve('web/package-lock.json', 'ours');
