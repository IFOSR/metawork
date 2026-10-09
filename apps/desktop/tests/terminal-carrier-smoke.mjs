import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const carrier = windows ? process.argv[2] ?? fileURLToPath(new URL('../../../.tmp/windows-terminal-probe/Release/metawork-terminal-client.exe', import.meta.url)) : '/usr/bin/python3';
const root = await mkdtemp(join(tmpdir(), 'metawork-terminal-'));
const stages = join(root, 'stages.txt');
const fixture = join(root, 'terminal.cjs');
await writeFile(fixture, `const fs = require('node:fs');
const stage = value => fs.appendFileSync(process.argv[2], value + '\\n');
stage('node-started');
stage('stdin-tty=' + process.stdin.isTTY);
stage('stdout-tty=' + process.stdout.isTTY);
stage('columns=' + process.stdout.columns);
if(!process.stdin.isTTY||!process.stdout.isTTY||process.stdout.columns<120)process.exit(2);
process.stdout.write('METAWORK_REAL_TERMINAL_OK\\n', () => { stage('output-flushed'); process.exit(0); });
`);
const args = [process.execPath, fixture, stages];
const child = spawn(carrier, windows ? args : [fileURLToPath(new URL('./terminal-client.py', import.meta.url)), ...args],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
try {
  const code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); });
  assert.equal(code, 0, output + '\n' + await readFile(stages, 'utf8').catch(() => 'Node entrypoint was not reached'));
  assert.ok(output.includes('METAWORK_REAL_TERMINAL_OK'));
  console.log('Acceptance carrier provides a real 140-column terminal to Node.');
} finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
