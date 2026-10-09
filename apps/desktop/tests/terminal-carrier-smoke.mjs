import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const carrier = windows ? fileURLToPath(new URL('../../../.tmp/windows-terminal-probe/Release/metawork-terminal-client.exe', import.meta.url)) : '/usr/bin/python3';
const args = [process.execPath, '-e', "if(!process.stdin.isTTY||!process.stdout.isTTY||process.stdout.columns<120)process.exit(2);process.stdout.write('METAWORK_REAL_TERMINAL_OK');"];
const child = spawn(carrier, windows ? args : [fileURLToPath(new URL('./terminal-client.py', import.meta.url)), ...args],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
try {
  const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); });
  assert.equal(code, 0, output);
  assert.ok(output.includes('METAWORK_REAL_TERMINAL_OK'));
  console.log('Acceptance carrier provides a real 140-column terminal to Node.');
} finally { clearTimeout(timer); }
