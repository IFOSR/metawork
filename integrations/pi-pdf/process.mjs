import { spawn } from 'node:child_process';
import { stat, realpath, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const maxCapture = 2 * 1024 * 1024;

export async function runPdfProcess(args, options = {}) {
  if (options.signal?.aborted) throw new Error('PDF operation cancelled');
  if (options.path && (await stat(options.path)).size > 50 * 1024 * 1024) {
    throw new Error('PDF exceeds the 50 MiB input limit');
  }
  if (options.outputDir) {
    const workspace = await realpath(options.cwd);
    // Resolve the closest existing parent before creating anything, including symlinks.
    let ancestor = resolve(options.outputDir);
    const suffix = [];
    while (!(await stat(ancestor).catch(() => null))) {
      suffix.unshift(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
    const output = resolve(await realpath(ancestor), ...suffix);
    const local = relative(workspace, output);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error('PDF images must be written inside the task workspace');
    }
    await mkdir(output, { recursive: true });
  }
  // Use the release's pinned packages; never inherit arbitrary user Python packages.
  const bootstrap = 'import sys,runpy;sys.path.insert(0,sys.argv.pop(1));a=sys.argv.pop(1);'
    + 'exec(compile(sys.argv.pop(1),"<pi-pdf>","exec")) if a=="-c" else runpy.run_path(a,run_name="__main__")';
  return new Promise((resolveResult, reject) => {
    const child = spawn(resolve(root, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'),
      ['-I', '-u', '-c', bootstrap, resolve(root, 'site-packages'), ...args],
      // Inherit Pi's process group so Kernel-authorized group cleanup includes this worker.
      { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', failure, killTimer;
    const signal = name => {
      if (!child.pid) return;
      try { process.kill(child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    };
    const abort = () => {
      failure ??= new Error('PDF operation cancelled');
      signal('SIGTERM');
      killTimer ??= setTimeout(() => signal('SIGKILL'), 5000);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const parentExit = () => signal('SIGTERM');
    process.once('exit', parentExit);
    if (options.signal?.aborted) abort();
    child.stdout.on('data', data => {
      stdout += data.toString();
      if (Buffer.byteLength(stdout) > maxCapture) {
        stdout = stdout.slice(0, maxCapture / 4);
        failure ??= new Error('PDF output exceeds limit; select fewer pages'); abort();
      }
    });
    child.stderr.on('data', data => {
      const text = data.toString();
      stderr = (stderr + text).slice(-maxCapture);
      pending = (pending + text).slice(-maxCapture);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('PDF_PROGRESS:')) {
        options.onUpdate?.({ content: [{ type: 'text', text: line.slice(13) }], details: { source: 'pi-pdf' } });
      }
    });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(killTimer);
      process.removeListener('exit', parentExit);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolveResult({ code, stdout, stderr });
    });
  });
}
