import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runBrowserE2e = process.env.RUN_BROWSER_E2E === '1';
const e2e = runBrowserE2e ? describe : describe.skip;

e2e('Settings workbench browser flow', () => {
  it('renders the capability workbench without horizontal overflow and edits an Auto pool', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const webDist = join(root, 'web', 'dist');
    await stat(join(webDist, 'index.html'));
    const server = await startMockServer(webDist);
    const profile = await mkdtemp(join(tmpdir(), 'anyfusion-settings-chrome-'));
    let chrome: ChildProcess | null = null;
    try {
      chrome = spawn(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,1000',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${server.port}/`,
      ], { stdio: 'ignore' });
      const debuggingPort = await waitForDebuggingPort(profile);
      const target = await waitForPageTarget(debuggingPort);
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`document.querySelector('.sidebar-settings').click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.settings-workbench'))`);
        await waitForExpression(
          cdp,
          `document.querySelectorAll('.provider-card').length === 2
            && document.querySelectorAll('.agent-route-card').length === 3`,
        );

        const initial = await cdp.evaluate(`(() => {
          const panel = document.querySelector('.settings-workbench');
          return {
            overflowFree: document.documentElement.scrollWidth <= window.innerWidth,
            viewportWidth: window.innerWidth,
            panelFits: panel.getBoundingClientRect().right <= window.innerWidth
              && panel.getBoundingClientRect().left >= 0,
            providerCards: document.querySelectorAll('.provider-card').length,
            modelCards: document.querySelectorAll('.model-card').length,
            routeCards: document.querySelectorAll('.agent-route-card').length,
            hasSuitability: document.body.innerText.includes('适合做什么'),
            hasRoutingExplanation: document.body.innerText.includes('为什么这样路由'),
            hasCandidateRejection: document.body.innerText.includes('排除 · 缺少'),
            hasModelFactsSection: document.body.innerText.includes('模型事实'),
            diagnosticsHidden: !document.querySelector('.diagnostics-panel'),
            workspaceHeader: document.querySelector('.workspace-runtime')?.textContent ?? '',
          };
        })()`);
        expect(initial).toMatchObject({
          overflowFree: true,
          viewportWidth: 1440,
          panelFits: true,
          providerCards: 2,
          modelCards: 0,
          routeCards: 3,
          hasSuitability: true,
          hasRoutingExplanation: true,
          hasCandidateRejection: true,
          hasModelFactsSection: false,
          diagnosticsHidden: true,
        });
        expect((initial as { workspaceHeader: string }).workspaceHeader).not.toContain('rev');

        await waitForExpression(
          cdp,
          `document.querySelectorAll('.provider-card')[0]?.querySelectorAll('.provider-model-line').length === 2`,
        );
        const providerDirectory = await cdp.evaluate(`(() => {
          const providerCard = document.querySelectorAll('.provider-card')[0];
          return {
            modelIds: [...providerCard.querySelectorAll('.provider-model-line > span:first-child')]
              .map(item => item.textContent),
            hasModelFacts: Boolean(document.querySelector('.model-card')),
          };
        })()`);
        expect(providerDirectory).toEqual({
          modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          hasModelFacts: false,
        });

        const pool = await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll('.agent-route-card')]
            .find(item => item.textContent.includes('Code CLI'));
          const boxes = [...card.querySelectorAll('.model-option input[type="checkbox"]')];
          const before = boxes.filter(box => box.checked).length;
          const candidate = boxes.find(box => !box.checked && !box.disabled);
          candidate.click();
          return {
            before,
            after: boxes.filter(box => box.checked).length,
            options: boxes.length,
          };
        })()`);
        expect(pool).toEqual({ before: 1, after: 2, options: 3 });

        const deletedProvider = await cdp.evaluate(`(() => {
          const card = document.querySelectorAll('.provider-card')[1];
          const button = [...card.querySelectorAll('button')]
            .find(item => item.textContent.includes('删除 Provider'));
          button.click();
          return {
            providerName: Boolean(card),
            providerCardsBeforeSettling: document.querySelectorAll('.provider-card').length,
          };
        })()`);
        expect(deletedProvider).toEqual({
          providerName: true,
          providerCardsBeforeSettling: 2,
        });
        await waitForExpression(cdp, `
          document.querySelectorAll('.provider-card').length === 1
          && document.body.innerText.includes('当前没有可用模型，请重新选择')
        `);
        const invalidAfterDelete = await cdp.evaluate(`(() => ({
          providerCards: document.querySelectorAll('.provider-card').length,
          fixedWarning: document.body.innerText.includes('当前没有可用模型，请重新选择'),
          saveDisabled: document.querySelector('.drawer-footer .primary-button').disabled,
          deletedModelStillInBody: document.body.innerText.includes('deepseek-v4-pro'),
        }))()`);
        expect(invalidAfterDelete).toEqual({
          providerCards: 1,
          fixedWarning: true,
          saveDisabled: true,
          deletedModelStillInBody: false,
        });

        await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll('.agent-route-card')]
            .find(item => item.textContent.includes('Pi Agent'));
          const selects = card.querySelectorAll('select');
          const select = selects[selects.length - 1];
          select.value = 'code-gpt-56';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitForExpression(cdp, `
          !document.querySelector('.drawer-footer .primary-button').disabled
        `);

        server.setBusy(true);
        await waitForExpression(cdp, `
          document.querySelector('.drawer-footer .primary-button').disabled
          && [...document.querySelectorAll('.provider-card button')]
            .every(button => button.disabled)
        `);
        const busyControls = await cdp.evaluate(`(() => ({
          saveDisabled: document.querySelector('.drawer-footer .primary-button').disabled,
          deleteDisabled: [...document.querySelectorAll('.provider-card button')]
            .every(button => button.disabled),
        }))()`);
        expect(busyControls).toEqual({ saveDisabled: true, deleteDisabled: true });
        server.setBusy(false);
        await waitForExpression(cdp, `
          !document.querySelector('.drawer-footer .primary-button').disabled
        `);

        await cdp.evaluate(`document.querySelector('.settings-intro .text-button').click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.diagnostics-panel'))`);
        const diagnostics = await cdp.evaluate(
          `document.querySelector('.diagnostics-panel').innerText`,
        );
        expect(diagnostics).toContain('revision-browser-test');
        await cdp.evaluate(`document.querySelector('.drawer-footer .primary-button').click()`);
        await waitForExpression(cdp, `document.body.innerText.includes('配置已热激活')`);
        const activated = server.getActivationPayload() as {
          config?: {
            providers?: Record<string, { enabled?: boolean }>;
            models?: Record<string, {
              costTier?: string;
              reasoning?: string;
              enabled?: boolean;
            }>;
            agentClasses?: Record<string, {
            modelPolicy?: {
              mode?: string;
              modelRef?: string;
              allowedModelRefs?: string[];
              defaultModelRef?: string;
            };
            }>;
          };
        };
        expect(activated.config?.providers?.deepseek).toBeUndefined();
        expect(activated.config?.models?.['deepseek-v4']).toBeUndefined();
        expect(activated.config?.models?.['code-gpt-56']).toMatchObject({
          costTier: 'high',
          reasoning: 'high',
          enabled: true,
        });
        expect(activated.config?.agentClasses?.['codex-cli']?.modelPolicy).toMatchObject({
          allowedModelRefs: ['code-gpt-56', 'code-gpt-56-terra'],
          defaultModelRef: 'code-gpt-56',
        });
        expect(activated.config?.agentClasses?.planner?.modelPolicy).toEqual({
          mode: 'fixed',
          modelRef: 'code-gpt-56',
        });
        expect(activated.config?.agentClasses?.['pi-agent']?.modelPolicy).toEqual({
          mode: 'fixed',
          modelRef: 'code-gpt-56',
        });
        if (process.env.BROWSER_E2E_SCREENSHOT) {
          const screenshot = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          }) as { data: string };
          await writeFile(process.env.BROWSER_E2E_SCREENSHOT, screenshot.data, 'base64');
        }
      } finally {
        cdp.close();
      }
    } finally {
      if (chrome) {
        chrome.kill('SIGTERM');
        await new Promise<void>(resolvePromise => {
          if (chrome!.exitCode !== null) {
            resolvePromise();
            return;
          }
          chrome!.once('exit', () => resolvePromise());
        });
      }
      await server.close();
      await rm(profile, { recursive: true, force: true });
    }
  }, 30_000);
});

async function startMockServer(webDist: string): Promise<{
  port: number;
  close(): Promise<void>;
  getActivationPayload(): unknown;
  setBusy(value: boolean): void;
}> {
  let activationPayload: unknown = null;
  let busy = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/auth/session') {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/ws/diagnostics') {
      json(response, { ok: false, reason: 'test', message: 'WebSocket disabled in browser fixture' });
      return;
    }
    if (url.pathname === '/api/sessions') {
      json(response, {
        activeSessionId: 'session-1',
        sessions: [{
          id: 'session-1',
          title: 'Settings verification',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
          active: true,
          archived: false,
        }],
      });
      return;
    }
    if (url.pathname === '/api/sessions/session-1') {
      json(response, {
        version: 1,
        session: {
          id: 'session-1',
          title: 'Settings verification',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
          active: true,
          archived: false,
        },
        turns: [],
      });
      return;
    }
    if (url.pathname === '/api/config/activation-status') {
      json(response, busy ? busyActivationState() : activationState());
      return;
    }
    if (url.pathname === '/api/config/secrets/status') {
      json(response, { 'code-cli': true, deepseek: true });
      return;
    }
    if (url.pathname === '/api/config/completion') {
      json(response, {
        providers: {
          'code-cli': {
            displayName: 'Code CLI',
            baseUrl: 'https://code.example/v1',
            credentialState: '已自动发现',
            modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          },
          deepseek: {
            displayName: 'DeepSeek',
            baseUrl: 'https://deepseek.example/v1',
            credentialState: '已自动发现',
            modelIds: ['deepseek-v4-pro'],
          },
        },
        providerPresets: [
          {
            providerRef: 'code-cli',
            displayName: 'Code CLI',
            baseUrl: 'https://code.example/v1',
            modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          },
          {
            providerRef: 'deepseek',
            displayName: 'DeepSeek',
            baseUrl: 'https://deepseek.example/v1',
            modelIds: ['deepseek-v4-pro'],
          },
        ],
        models: {},
        requiredFields: [],
      });
      return;
    }
    if (url.pathname === '/api/config') {
      json(response, configuration());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/activate') {
      void readJsonBody(request).then(body => {
        activationPayload = body;
        json(response, {
          ok: true,
          revisionId: 'revision-browser-activated',
          activeRevisionId: 'revision-browser-activated',
          runningRevisionId: 'revision-browser-activated',
          restartRequired: false,
        });
      });
      return;
    }
    void serveStatic(webDist, url.pathname, response);
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
  return {
    port: address.port,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close(error => error ? reject(error) : resolvePromise());
    }),
    getActivationPayload: () => activationPayload,
    setBusy: value => { busy = value; },
  };
}

function configuration() {
  return {
    revisionId: 'revision-browser-test',
    runningRevisionId: 'revision-browser-test',
    contentHash: 'sha256:browser-test',
    ...activationState(),
    config: {
      schemaVersion: 2,
      providers: {
        'code-cli': {
          protocol: 'openai-compatible',
          baseUrl: 'https://code.example/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code-cli',
          region: 'international',
          enabled: true,
        },
        deepseek: {
          protocol: 'openai-compatible',
          baseUrl: 'https://deepseek.example/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/deepseek',
          region: 'international',
          enabled: false,
        },
      },
      models: {
        'code-gpt-56': model('code-cli', 'gpt-5.6-sol', ['coding', 'planning', 'structured-output', 'tools']),
        'code-gpt-56-terra': model('code-cli', 'gpt-5.6-terra', ['coding', 'tools']),
        'deepseek-v4': model('deepseek', 'deepseek-v4-pro', ['planning', 'structured-output', 'tools']),
      },
      harnesses: {
        'anyfusion-planner': harness('planner', 'local-process', 'anyfusion-planner-host-v2'),
        'codex-cli': harness('executor', 'local-cli', 'codex-cli'),
        'pi-cli': harness('executor', 'local-cli', 'pi-cli'),
      },
      agentClasses: {
        planner: agentClass(
          'planner',
          'anyfusion-planner',
          [],
          [],
          [],
          { mode: 'fixed', modelRef: 'code-gpt-56' },
        ),
        'codex-cli': agentClass(
          'executor',
          'codex-cli',
          ['workspace-engineering'],
          ['repository implementation', 'tests'],
          ['current public-web research'],
          {
            mode: 'auto',
            allowedModelRefs: ['code-gpt-56'],
            defaultModelRef: 'code-gpt-56',
            objective: { priority: 'balanced' },
          },
          ['workspace-read-write', 'workspace-command-validation'],
        ),
        'pi-agent': agentClass(
          'executor',
          'pi-cli',
          ['current-web-research'],
          ['current public-web research', 'source verification'],
          ['repository modification'],
          { mode: 'fixed', modelRef: 'deepseek-v4' },
          ['public-web-search', 'public-web-fetch', 'source-citation'],
        ),
      },
      permissionProfiles: {},
      runtimePolicy: {},
      gateway: {},
    },
  };
}

function activationState() {
  return {
    activeRevisionId: 'revision-browser-test',
    runtimeRevisionId: 'revision-browser-test',
    activationStatus: 'idle',
    activationAllowed: true,
    blockingReasons: [],
    activeTaskId: null,
    activeAttemptCount: 0,
    plannerTurnActive: false,
    hotActivationSupported: true,
    restartRequired: false,
    checkedAt: '2026-08-23T00:00:00.000Z',
  };
}

function busyActivationState() {
  return {
    ...activationState(),
    activationStatus: 'busy',
    activationAllowed: false,
    activeTaskId: 'task-browser-busy',
    activeAttemptCount: 1,
    plannerTurnActive: true,
    blockingReasons: [
      { code: 'planner_turn_active', message: 'Planner 正在处理当前请求。' },
      { code: 'task_running', message: '任务 task-browser-busy 正在后台执行。' },
    ],
  };
}

function model(providerRef: string, modelId: string, capabilities: string[]) {
  return {
    providerRef,
    modelId,
    capabilities,
    reasoning: 'high',
    contextLimit: 128_000,
    latencyTier: 'medium',
    qualityTier: 'high',
    costTier: 'high',
    enabled: true,
  };
}

function harness(kind: string, transport: string, driverId: string) {
  return {
    kind,
    transport,
    driverId,
    supportsProbe: true,
    supportsAbort: true,
    supportsContinuation: true,
    enabled: true,
  };
}

function agentClass(
  kind: string,
  harnessRef: string,
  routingCapabilities: string[],
  primaryUseCases: string[],
  avoidUseCases: string[],
  modelPolicy: Record<string, unknown>,
  plannerAffordances: string[] = [],
) {
  return {
    kind,
    harnessRef,
    modelPolicy,
    routingCapabilities,
    primaryUseCases,
    avoidUseCases,
    plannerAffordances,
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: harnessRef,
    enabled: true,
  };
}

async function serveStatic(
  root: string,
  pathname: string,
  response: import('node:http').ServerResponse,
) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root))) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    }[extname(path)] ?? 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}

function json(response: import('node:http').ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

async function waitForPageTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(target => target.type === 'page');
    if (page) return page;
    await delay(50);
  }
  throw new Error('Chrome page target was not created');
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
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
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as {
      result: { value: unknown };
      exceptionDetails?: {
        text: string;
        exception?: { description?: string };
      };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForExpression(cdp: CdpClient, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`browser condition timed out: ${expression}`);
}
