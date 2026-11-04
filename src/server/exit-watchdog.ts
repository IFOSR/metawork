import { spawn } from 'node:child_process';

/**
 * Total budget for draining and for the native exit that follows it.
 *
 * Node cannot bound its own exit: `process.exit()` runs native cleanup, and
 * `uv_threadpool_cleanup()` waits on `uv_thread_join()` with no timeout. A
 * pending threadpool work item therefore leaves the process alive after it has
 * already withdrawn its endpoints, released its lock and consumed its one-shot
 * signal handler, which is unrecoverable from the outside: a second SIGTERM is
 * never dispatched because the JS thread does not return to the event loop.
 */
export const DEFAULT_EXIT_WATCHDOG_MS = 60_000;

export function exitWatchdogTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.METAWORK_EXIT_WATCHDOG_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_EXIT_WATCHDOG_MS;
}

/**
 * Arm a detached watchdog that SIGKILLs this process when it is still alive
 * after the shutdown budget.
 *
 * Endpoints and the instance lock are withdrawn before the budget expires, so
 * the kill cannot admit a new request or corrupt a committed write: SQLite runs
 * in WAL mode and the Server only ever appends through repositories that have
 * already been closed by the drain. The watchdog exits on its own when the
 * parent is gone (`process.kill` then fails with ESRCH).
 */
export function armExitWatchdog(options: {
  pid?: number;
  timeoutMs?: number;
  spawn?: typeof spawn;
  execPath?: string;
} = {}): void {
  if (process.platform === 'win32') return;
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? exitWatchdogTimeout();
  const launch = options.spawn ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  // The watchdog must stay alive to be able to fire, so it polls instead of
  // unref-ing a timer: it exits on its own once the Server is gone, and kills it
  // at the deadline otherwise. The kill is guarded by the process start time
  // captured now, so a reused PID can never be mistaken for this Server.
  const script = 'const pid=' + pid + ',deadline=Date.now()+' + timeoutMs + ';'
    + 'const ps=require("node:child_process");'
    + 'const identity=()=>{try{return ps.execFileSync("/bin/ps",["-p",String(pid),"-o","lstart="],'
    + '{stdio:["ignore","pipe","ignore"],timeout:4000}).toString().trim();}catch{return "";}};'
    + 'const stamp=identity();'
    + 'const iv=setInterval(()=>{let alive=true;try{process.kill(pid,0);}catch{alive=false;}'
    + 'if(!alive){clearInterval(iv);process.exit(0);}'
    + 'if(Date.now()>=deadline){'
    + 'if(stamp!==""&&identity()===stamp){try{process.kill(pid,"SIGKILL");}catch{}}'
    + 'clearInterval(iv);process.exit(0);}},500);';
  try {
    const child = launch(execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // A missing watchdog must never make shutdown throw. The Desktop stopper
    // bounds the same exit from outside, so this is a defence in depth.
  }
}
