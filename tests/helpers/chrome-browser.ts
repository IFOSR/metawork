import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchBrowser(port: number, prefix: string): Promise<{
  cdp: CdpClient;
  close(): Promise<void>;
}> {
  const profile = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore' });
  try {
  const debuggingPort = await waitForDebuggingPort(profile);
  const target = await waitForPageTarget(debuggingPort, port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return {
    cdp,
    async close() {
      cdp.close();
      chrome.kill('SIGTERM');
      await waitForExit(chrome);
      await rm(profile, { recursive: true, force: true });
    },
  };
  } catch (error) {
    chrome.kill('SIGTERM');
    await waitForExit(chrome);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function waitForDebuggingPort(profile: string): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return Number((await readFile(file, 'utf8')).split('\n')[0]);
    } catch {
      await delay(50);
    }
  }
  throw new Error('Chrome DevTools port was not created');
}

async function waitForPageTarget(port: number, serverPort: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then(response => response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(target => target.type === 'page' && target.url.startsWith(`http://127.0.0.1:${serverPort}/`));
    if (page) return page;
    await delay(50);
  }
  throw new Error('Chrome page target was not created');
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const timeout = setTimeout(() => process.kill('SIGKILL'), 5000);
  try { await new Promise<void>(resolvePromise => process.once('exit', () => resolvePromise())); }
  finally { clearTimeout(timeout); }
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as {
      result: { value: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

export async function waitForExpression(cdp: CdpClient, expression: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  const state = await cdp.evaluate(`(() => ({
    text: document.body?.innerText?.slice(0, 2000) ?? '',
    html: document.body?.innerHTML?.slice(0, 1200) ?? '',
    url: location.href,
  }))()`);
  throw new Error(`browser condition timed out: ${expression}\n${JSON.stringify(state)}`);
}
