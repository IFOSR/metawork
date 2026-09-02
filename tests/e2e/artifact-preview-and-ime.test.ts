import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runBrowserE2e = process.env.RUN_BROWSER_E2E === '1';
const e2e = runBrowserE2e ? describe : describe.skip;

const ARTIFACT_A = {
  artifactId: 'artifact_aaa',
  taskId: 'task_e2e001',
  publicationId: null,
  displayName: 'report.md',
  relativePath: 'report.md',
  mediaType: 'text/markdown; charset=utf-8',
  previewKind: 'markdown' as const,
  previewable: true,
  byteLength: 30,
  contentHash: 'sha256:a',
  publishedAt: '2026-08-24T01:00:00.000Z',
};
const ARTIFACT_B = {
  ...ARTIFACT_A,
  artifactId: 'artifact_bbb',
  displayName: 'summary.md',
  relativePath: 'summary.md',
  contentHash: 'sha256:b',
};

function turnFixture() {
  return [
    {
      // 模拟 schema 升级前的历史落盘 turn：没有 artifacts 字段。
      id: 'turn_e2e_legacy',
      sessionId: 'session-1',
      userInput: '历史请求（无 artifacts 字段）',
      status: 'completed' as const,
      finalAnswer: '历史结果。',
      taskId: null,
      startedAt: '2026-08-23T01:00:00.000Z',
      completedAt: '2026-08-23T01:05:00.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
    },
    {
      id: 'turn_e2e_1',
      sessionId: 'session-1',
      userInput: '生成季度报告',
      status: 'completed' as const,
      finalAnswer: '报告已完成。\n\n产物：report.md',
      taskId: 'task_e2e001',
      startedAt: '2026-08-24T01:00:00.000Z',
      completedAt: '2026-08-24T01:05:00.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: ['report.md', 'summary.md'],
      artifacts: [ARTIFACT_A, ARTIFACT_B],
    },
  ];
}

e2e('Artifact preview drawer and IME-aware Enter browser flow', () => {
  it('opens the drawer by artifact id, switches previews, restores layout, and separates IME Enter from send', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const webDist = join(root, 'web', 'dist');
    await stat(join(webDist, 'index.html'));
    const server = await startMockServer(webDist);
    const profile = await mkdtemp(join(tmpdir(), 'anyfusion-artifact-chrome-'));
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
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const debuggingPort = await waitForDebuggingPort(profile, chrome);
      const target = await waitForPageTarget(debuggingPort);
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        // 在页面脚本运行前安装 WebSocket 发送钩子，用于观察真实发送行为。
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `
            window.__sentInputs = [];
            window.__wsSends = 0;
            const OriginalWsSend = WebSocket.prototype.send;
            WebSocket.prototype.send = function (data) {
              window.__wsSends += 1;
              try {
                const parsed = JSON.parse(String(data));
                if (parsed && parsed.type === 'input') window.__sentInputs.push(parsed.text);
              } catch {}
              return OriginalWsSend.call(this, data);
            };
          `,
        });
        // 显式导航一次，确保钩子在应用脚本之前注入。
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });

        // 等待会话与历史 turn（含 artifacts）渲染；历史 turn（无 artifacts 字段）
        // 必须正常渲染而不是让整页空白。
        await waitForExpression(cdp, `Boolean(document.querySelector('.conversation-turn'))`);
        await waitForExpression(cdp, `document.querySelectorAll('.conversation-turn').length >= 2`);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('历史请求（无 artifacts 字段）')`,
        )).toBe(true);
        await waitForExpression(cdp, `document.querySelectorAll('.artifact-link').length >= 2`);
        await waitForExpression(cdp, `Boolean(document.querySelector('[data-artifact-reference="artifact_aaa"]'))`);
        expect(await cdp.evaluate(
          `document.querySelector('[data-artifact-reference="artifact_aaa"]')?.textContent ?? ''`,
        )).toContain('report.md');

        // Composer 只属于对话页；切换轨迹不会清空草稿。
        await cdp.evaluate(`
          (() => {
            const textarea = document.querySelector('.composer textarea');
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value',
            ).set;
            setter.call(textarea, '保留的草稿');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelectorAll('.workspace-tabs button')[1].click();
          })()
        `);
        await waitForExpression(cdp, `!document.querySelector('.composer')`);
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[0].click()`);
        await waitForExpression(cdp, `document.querySelector('.composer textarea')?.value === '保留的草稿'`);

        // 1. 点击第一个报告链接 → 右侧预览抽屉打开，显示 Markdown 内容。
        await cdp.evaluate(`document.querySelectorAll('.artifact-link')[0].click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.artifact-preview-drawer'))`);
        await waitForExpression(cdp, `document.querySelector('.artifact-drawer-title strong')?.textContent === 'report.md'`);
        await waitForExpression(cdp, `(document.querySelector('.artifact-drawer-body .markdown-content')?.textContent ?? '').includes('季度报告')`);
        const firstContent = await cdp.evaluate(
          `document.querySelector('.artifact-drawer-body .markdown-content')?.textContent ?? ''`,
        );
        expect(String(firstContent)).toContain('正文内容');
        expect(String(firstContent)).not.toContain('#');
        expect(await cdp.evaluate(
          `document.querySelector('.final-answer')?.textContent ?? ''`,
        )).not.toContain('artifacts/');
        // 抽屉打开时无全局横向滚动。
        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);
        expect(await cdp.evaluate(
          `document.querySelector('.workspace-shell')?.dataset.previewOpen === 'true'`,
        )).toBe(true);

        // 2. 连续点击第二个 artifact → 预览内容正确切换。
        await cdp.evaluate(`document.querySelectorAll('.artifact-link')[1].click()`);
        await waitForExpression(cdp, `document.querySelector('.artifact-drawer-title strong')?.textContent === 'summary.md'`);
        const secondContent = await cdp.evaluate(
          `document.querySelector('.artifact-drawer-body .markdown-content')?.textContent ?? ''`,
        );
        expect(String(secondContent)).toContain('第二份文档');

        // 3. Escape 关闭抽屉 → 主对话恢复全宽。
        await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await waitForExpression(cdp, `!document.querySelector('.workspace-shell')?.dataset.previewOpen`);
        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);

        // 4. IME 合成期间 Enter 只确认候选词，不发送；普通 Enter 发送。
        await cdp.evaluate(`
          (() => {
            window.__sentInputs = [];
            const textarea = document.querySelector('.composer textarea');
            if (!textarea) throw new Error('textarea missing');
            textarea.focus();
            const setValue = (v) => {
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value',
              ).set;
              setter.call(textarea, v);
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
            };
            window.__setComposerValue = setValue;
            // 模拟 IME composition 开始。
            textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            setValue('你好');
            // 合成期间按 Enter：isComposing=true 且 keyCode=229。
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', keyCode: 229, which: 229, bubbles: true,
            }));
            return true;
          })()
        `);
        await delay(200);
        expect(await cdp.evaluate(`window.__sentInputs.length`)).toBe(0);

        await cdp.evaluate(`
          (() => {
            const textarea = document.querySelector('.composer textarea');
            // compositionend 之后同一次 keydown（Safari 时序）也不发送。
            textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', keyCode: 229, which: 229, bubbles: true,
            }));
            return true;
          })()
        `);
        await delay(150);
        expect(await cdp.evaluate(`window.__sentInputs.length`)).toBe(0);

        // 非 IME 状态的普通 Enter 发送。
        await cdp.evaluate(`
          (() => {
            window.__setComposerValue('普通英文输入');
            document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            return true;
          })()
        `);
        await waitForExpression(cdp, `window.__wsSends === 1 && window.__sentInputs.length === 1`);
        expect(await cdp.evaluate(`JSON.stringify(window.__sentInputs[0])`))
          .toContain('普通英文输入');

        // Shift+Enter 不发送（换行）。
        server.receivedInputs.length = 0;
        await cdp.evaluate(`
          (() => {
            window.__setComposerValue('第一行');
            document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', keyCode: 13, shiftKey: true, bubbles: true,
            }));
            return true;
          })()
        `);
        await delay(150);
        expect(server.receivedInputs.length).toBe(0);

        // ── Executor 执行透明化：实时信息流 + 可点击子任务详情抽屉 ──
        // 模拟 Gateway 实时推送：turn_started + trace_snapshot（富进度事件）。
        server.pushWs(JSON.stringify({
          type: 'turn_started',
          requestId: 'req_live',
          turnId: 'turn_live_1',
          userInput: '研究港股智谱股价持续下跌的原因',
          startedAt: new Date().toISOString(),
        }));
        server.pushWs(JSON.stringify({
          type: 'execution',
          taskId: 'task_live',
          timeline: {
            taskId: 'task_live',
            title: '研究港股智谱股价持续下跌的原因',
            status: 'done',
            stages: [{
              phase: 'execution',
              status: 'done',
              subtasks: [{
                id: 'subtask_research_1',
                title: '研究港股智谱股价持续下跌的原因',
                status: 'done',
                executor: 'Codex CLI',
                attempts: [{
                  attemptId: 'attempt_dispatch_event_exec_int_4qLeqcgC5h_task_plan_event_proposal_primary',
                  attemptKind: 'primary',
                  attemptOrdinal: 1,
                  attemptLabel: '主执行',
                  displayStatus: '已完成',
                  result: 'success',
                  status: 'terminal',
                  startedAt: new Date(Date.now() - 4_000).toISOString(),
                  updatedAt: new Date().toISOString(),
                }],
              }],
            }],
          },
        }));
        server.pushWs(JSON.stringify({
          type: 'trace_snapshot',
          trace: {
            sessionId: 'session-1',
            turnId: 'turn_live_1',
            taskId: 'task_live',
            status: 'running',
            startedAt: new Date().toISOString(),
            completedAt: null,
            events: [
              {
                id: 'interaction:turn_live_1:executor_routed:1',
                sequence: 1,
                occurredAt: new Date().toISOString(),
                phase: 'routing',
                actor: 'kernel',
                kind: 'executor_routed',
                status: 'completed',
                title: 'Primary Executor authorized',
                summary: 'pi-agent via pi-cli using deepseek/deepseek-v4-pro',
                details: {
                  subtaskId: 'subtask_research_1',
                  subtaskTitle: '研究港股智谱股价持续下跌的原因',
                  executorDisplayName: 'Pi Agent',
                  harnessDisplayName: 'Pi Cli',
                  providerDisplayName: 'Deepseek',
                  modelDisplayName: 'Deepseek V4 Pro',
                },
              },
              {
                id: 'interaction:turn_live_1:executor_progress:1',
                sequence: 2,
                occurredAt: new Date().toISOString(),
                phase: 'execution',
                actor: 'executor',
                kind: 'executor_progress',
                status: 'running',
                title: 'Executor progress: status',
                summary: 'Executor: 我先检查最近的公告，再对比同行业估值。',
                details: {
                  subtaskId: 'subtask_research_1',
                  subtaskTitle: '研究港股智谱股价持续下跌的原因',
                  executorDisplayName: 'Pi Agent',
                  harnessDisplayName: 'Pi Cli',
                  providerDisplayName: 'Deepseek',
                  modelDisplayName: 'Deepseek V4 Pro',
                  stepKey: 'executor_progress',
                  stepLabel: '我先检查最近的公告，再对比同行业估值。',
                  progress: null,
                },
              },
              {
                id: 'interaction:turn_live_1:executor_progress:2',
                sequence: 3,
                occurredAt: new Date().toISOString(),
                phase: 'execution',
                actor: 'executor',
                kind: 'executor_progress',
                status: 'running',
                title: 'Executor progress: skill',
                summary: 'Executor started tool: web_search — 智谱 股价 下跌 原因',
                details: {
                  subtaskId: 'subtask_research_1',
                  subtaskTitle: '研究港股智谱股价持续下跌的原因',
                  executorDisplayName: 'Pi Agent',
                  providerDisplayName: 'Deepseek',
                  modelDisplayName: 'Deepseek V4 Pro',
                  stepKey: 'executor_progress',
                  stepLabel: 'web_search — 智谱 股价 下跌 原因',
                  progress: null,
                },
              },
            ],
          },
        }));

        // 实时执行卡片出现，主对话框叙述同步流出富进度。
        await waitForExpression(cdp, `Boolean(document.querySelector('.live-execution-panel'))`);
        await waitForExpression(cdp, `document.body.innerText.includes('我先检查最近的公告，再对比同行业估值。')`);
        await waitForExpression(cdp, `document.body.innerText.includes('主执行')`);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('attempt_dispatch_event_exec_int_')`,
        )).toBe(false);
        expect(await cdp.evaluate(`document.body.innerText.includes('terminal')`)).toBe(false);
        // 点击子任务卡 → 执行详情抽屉打开，显示完整时间线。
        await cdp.evaluate(`document.querySelector('.execution-card.is-clickable').click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.execution-detail-drawer'))`);
        await waitForExpression(cdp, `document.querySelectorAll('.execution-detail-stream li').length >= 3`);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('Executor started tool: web_search — 智谱 股价 下跌 原因')`,
        )).toBe(true);
        expect(await cdp.evaluate(
          `document.querySelector('.execution-detail-title strong')?.textContent`,
        )).toBe('研究港股智谱股价持续下跌的原因');

        // 实时流：再推一条事件，抽屉不刷新页面自动追加。
        server.pushWs(JSON.stringify({
          type: 'trace_delta',
          turnId: 'turn_live_1',
          fromSequence: 4,
          events: [{
            id: 'interaction:turn_live_1:executor_progress:3',
            sequence: 4,
            occurredAt: new Date().toISOString(),
            phase: 'execution',
            actor: 'executor',
            kind: 'executor_progress',
            status: 'running',
            title: 'Executor progress: status',
            summary: 'Executor: 公告确认了裁员消息，接下来查资金流向数据。',
            details: {
              subtaskId: 'subtask_research_1',
              subtaskTitle: '研究港股智谱股价持续下跌的原因',
              stepKey: 'executor_progress',
              stepLabel: '公告确认了裁员消息，接下来查资金流向数据。',
              progress: null,
            },
          }],
        }));
        await waitForExpression(cdp, `document.querySelectorAll('.execution-detail-stream li').length >= 4`);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('公告确认了裁员消息，接下来查资金流向数据。')`,
        )).toBe(true);

        // Escape 关闭执行详情抽屉。
        await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await waitForExpression(cdp, `!document.querySelector('.execution-detail-drawer')`);

        // 轨迹页展示公共路由身份，不泄露 modelRef，并且没有 Composer。
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[1].click()`);
        await waitForExpression(cdp, `document.body.innerText.includes('未入选模型候选')`);
        expect(await cdp.evaluate(`document.body.innerText.includes('Code CLI / gpt-5.6-sol')`))
          .toBe(true);
        expect(await cdp.evaluate(`document.body.innerText.includes('Code CLI / gpt-5.6-terra')`))
          .toBe(true);
        expect(await cdp.evaluate(`document.body.innerText.includes('code-cli-5')`)).toBe(false);
        expect(await cdp.evaluate(`Boolean(document.querySelector('.composer'))`)).toBe(false);

        // 三态主题：固定主题持久化，system 响应系统媒体变化。
        await cdp.evaluate(`
          [...document.querySelectorAll('.theme-control button')]
            .find(button => button.textContent === '浅色').click()
        `);
        await waitForExpression(cdp, `document.documentElement.dataset.theme === 'light'`);
        expect(await cdp.evaluate(`localStorage.getItem('metawork.theme')`)).toBe('light');
        expect(await cdp.evaluate(`localStorage.getItem('anyfusion.theme')`)).toBeNull();
        await cdp.evaluate(`
          [...document.querySelectorAll('.theme-control button')]
            .find(button => button.textContent === '跟随系统').click()
        `);
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        });
        await waitForExpression(cdp, `document.documentElement.dataset.theme === 'dark'`);

        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);
      } finally {
        cdp.close();
      }
    } finally {
      chrome?.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      await server.close();
    }
  }, 60_000);
});

async function startMockServer(webDist: string): Promise<{
  port: number;
  receivedInputs: string[];
  pushWs(text: string): void;
  close(): Promise<void>;
}> {
  const receivedInputs: string[] = [];
  let wsSender: ((text: string) => void) | null = null;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.on('upgrade', (request, socket) => {
    try {
    if (!request.url || new URL(request.url, 'http://127.0.0.1').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const headerKey = request.headers['sec-websocket-key'];
    const key = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const sendServerFrame = (text: string) => {
      const payload = Buffer.from(text, 'utf8');
      const header = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, payload]));
    };
    wsSender = sendServerFrame;
    sendServerFrame(JSON.stringify({ type: 'hello', sessionId: 'session-1' }));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const maskBit = (buffer[1]! & 0x80) !== 0;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + (maskBit ? 4 : 0) + length) return;
        const maskKey = maskBit ? buffer.subarray(offset, offset + 4) : null;
        const masked = buffer.subarray(offset + (maskBit ? 4 : 0), offset + (maskBit ? 4 : 0) + length);
        const text = Buffer.from(masked.map((byte, index) => (
          maskKey ? byte ^ maskKey[index % 4]! : byte
        ))).toString('utf8');
        buffer = buffer.subarray(offset + (maskBit ? 4 : 0) + length);
        try {
          const message = JSON.parse(text) as { type?: string; text?: string };
          if (message.type === 'input' && message.text) receivedInputs.push(message.text);
          if (message.type === 'close') socket.destroy();
        } catch {
          socket.destroy();
        }
      }
    });
    socket.on('error', () => socket.destroy());
    } catch (error) {
      console.error('[mock ws] upgrade failed:', error);
      socket.destroy();
    }
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/auth/session') {
      json(response, { authenticated: true, launchContext: null });
      return;
    }
    if (url.pathname === '/api/ws/diagnostics') {
      json(response, { ok: false, reason: 'test', message: '' });
      return;
    }
    if (url.pathname === '/api/workspaces') {
      json(response, {
        activeWorkspaceId: 'workspace-1',
        workspaces: [{
          id: 'workspace-1',
          accountId: 'local-default',
          displayName: 'artifact-workspace',
          canonicalPath: '/repo-artifact',
          availability: 'available',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          createdByPrincipal: 'web:browser-test',
          archived: false,
        }],
      });
      return;
    }
    if (url.pathname === '/api/workspaces/workspace-1/conversations') {
      json(response, {
        activeWorkspaceId: 'workspace-1',
        activeConversationId: 'session-1',
        conversations: [{
          id: 'session-1',
          workspaceId: 'workspace-1',
          title: '产物预览验证',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          active: true,
          archived: false,
          preview: '产物预览验证',
          activity: {
            state: 'idle',
            taskId: null,
            updatedAt: '2026-08-24T00:00:00.000Z',
          },
          workspace: null,
        }],
      });
      return;
    }
    if (url.pathname === '/api/conversations/session-1') {
      json(response, {
        version: 1,
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          title: '产物预览验证',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          active: true,
          archived: false,
          workspace: null,
        },
        turns: turnFixture(),
      });
      return;
    }
    if (url.pathname === '/api/artifacts/artifact_aaa/preview') {
      json(response, { artifact: ARTIFACT_A, content: '# 季度报告\n\n正文内容。' });
      return;
    }
    if (url.pathname === '/api/artifacts/artifact_bbb/preview') {
      json(response, { artifact: ARTIFACT_B, content: '## 摘要\n\n第二份文档。' });
      return;
    }
    if (url.pathname.startsWith('/api/artifacts/artifact_aaa')) {
      json(response, { artifact: ARTIFACT_A });
      return;
    }
    if (url.pathname.startsWith('/api/artifacts/artifact_bbb')) {
      json(response, { artifact: ARTIFACT_B });
      return;
    }
    if (url.pathname.startsWith('/api/artifacts/unknown')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (url.pathname === '/api/config') {
      json(response, {
        revisionId: 'revision-browser-test',
        runningRevisionId: 'revision-browser-test',
        contentHash: 'sha256:browser-test',
        config: {},
      });
      return;
    }
    if (url.pathname === '/api/execution/tasks/task_live/work-graph') {
      json(response, {
        generationId: 'generation-live',
        nodes: [{
          id: 'subtask_research_1',
          title: '研究港股智谱股价持续下跌的原因',
          goal: '完成研究并输出结论',
          status: 'done',
          phase: 0,
          runnable: false,
          dependencies: [],
          requiredCapabilities: ['coding'],
          acceptanceCriteria: ['完成研究'],
          routing: [{
            executorDisplayName: 'Codex CLI',
            harnessDisplayName: 'Codex CLI',
            policy: 'auto',
            selected: {
              providerDisplayName: 'Code CLI',
              modelDisplayName: 'gpt-5.6-sol',
            },
            rejectedCandidates: [{
              providerDisplayName: 'Code CLI',
              modelDisplayName: 'gpt-5.6-terra',
              reasonCode: 'missing_capability',
              reasonDetail: 'coding',
            }],
          }],
        }],
        edges: [],
        parallelGroups: [['subtask_research_1']],
        currentRunnableFrontier: [],
      });
      return;
    }
    await serveStatic(webDist, url.pathname, response);
  }

  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
  return {
    port: address.port,
    receivedInputs,
    pushWs: text => wsSender?.(text),
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close(error => error ? rejectPromise(error) : resolvePromise());
    }),
  };
}

async function serveStatic(
  root: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
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

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function waitForDebuggingPort(profile: string, chrome: ChildProcess): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  let stderr = '';
  const stderrStream = chrome.stderr;
  const onStderr = (chunk: Buffer | string) => {
    stderr += chunk.toString();
  };
  stderrStream?.on('data', onStderr);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const advertisedPort = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//u)?.[1];
    if (advertisedPort) {
      stderrStream?.off('data', onStderr);
      return Number(advertisedPort);
    }
    try {
      const port = Number((await readFile(file, 'utf8')).split('\n')[0]);
      stderrStream?.off('data', onStderr);
      return port;
    } catch {
      await delay(50);
    }
  }
  stderrStream?.off('data', onStderr);
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch (error) {
      // 表达式尚未可用（例如钩子变量未注入）；继续等待。
    }
    await delay(50);
  }
  const snapshot = await cdp.evaluate(
    `JSON.stringify({ body: document.body.innerText.slice(0, 300), root: document.getElementById('root')?.innerHTML.slice(0, 300) })`,
  );
  throw new Error(`browser condition timed out: ${expression}\npage: ${snapshot}`);
}
