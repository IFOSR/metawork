import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionPresentation,
} from '../../src/management/execution-presentation-normalizer.js';
import type { ConversationTurn } from '../../src/management/web-session-types.js';
import { buildCanonicalSubtaskIdentityMap } from '../../src/work-graph/subtask-identity.js';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runBrowserE2e = process.env.RUN_BROWSER_E2E === '1';
const e2e = runBrowserE2e ? describe : describe.skip;
const canonicalSubtaskId = 'task_live_r1_research';
const longAttemptId =
  'attempt_dispatch_event_exec_int_4qLeqcgC5h_task_plan_event_proposal_75489ce1d2a9f2fe16a8dc6555ef91_9585a4ae3fb766a2_1e42ba821130bea162012d6aa46d76ae4357e8d092f99855583502cc897f9685_primary';

e2e('Web routing identity, canonical execution cards, and theme presentation', () => {
  it('shows only public identities and preserves workspace state across views and themes', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const webDist = join(root, 'web', 'dist');
    await stat(join(webDist, 'index.html'));
    const server = await startMockServer(webDist);
    const profile = await mkdtemp(join(tmpdir(), 'anyfusion-routing-theme-chrome-'));
    const attachmentPath = join(profile, '分析备注.txt');
    await writeFile(attachmentPath, '附件在轨迹页切换后仍需保留。', 'utf8');
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
        await cdp.send('DOM.enable');
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        });
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });
        await waitForWorkspace(cdp);
        expect(await cdp.evaluate(
          `document.querySelector('.workspace-path code')?.textContent`,
        )).toBe('/repo-browser-e2e');

        expect(await cdp.evaluate(
          `document.documentElement.dataset.themePreference`,
        )).toBe('system');
        expect(await cdp.evaluate(`document.documentElement.dataset.theme`)).toBe('dark');
        await assertUserMessageReadability(cdp, 'dark');

        // 历史 fixture 同时包含 proposal ID 和 Runtime ID，公开投影只能形成一张卡。
        expect(await cdp.evaluate(
          `document.querySelectorAll('.live-execution-panel .execution-card').length`,
        )).toBe(1);
        const executionCardText = await cdp.evaluate(
          `document.querySelector('.execution-card')?.innerText ?? ''`,
        );
        expect(String(executionCardText)).toContain('Codex CLI');
        expect(String(executionCardText)).toContain('gpt-5.6-sol');
        expect(await cdp.evaluate(`document.body.innerText.includes('主执行')`)).toBe(true);
        expect(await cdp.evaluate(`document.body.innerText.includes('已完成')`)).toBe(true);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('attempt_dispatch_event_exec_int_')`,
        )).toBe(false);
        expect(await cdp.evaluate(`document.body.innerText.includes('terminal')`)).toBe(false);
        expect(await cdp.evaluate(
          `document.body.innerText.includes('${canonicalSubtaskId}')`,
        )).toBe(false);
        expect(await attemptHeaderLayout(cdp)).toMatchObject({
          overflowFree: true,
          labelOverlapsStatus: false,
          statusOverlapsDuration: false,
        });

        await cdp.evaluate(`document.querySelector('.execution-card.is-clickable').click()`);
        await waitForExpression(
          cdp,
          `document.querySelectorAll('.execution-detail-stream li').length >= 4`,
        );
        expect(await cdp.evaluate(
          `document.querySelector('.execution-detail-title strong')?.textContent`,
        )).toBe('研究港股智谱股价持续下跌的原因');
        await cdp.evaluate(
          `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
        );
        await waitForExpression(cdp, `!document.querySelector('.execution-detail-drawer')`);

        // Composer 状态由 App 持有，轨迹页卸载 Composer DOM 后仍保留草稿和附件。
        await cdp.evaluate(`
          (() => {
            const textarea = document.querySelector('.composer textarea');
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value',
            ).set;
            setter.call(textarea, '保留的智谱分析草稿');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          })()
        `);
        await setFileInputFiles(cdp, attachmentPath);
        await waitForExpression(
          cdp,
          `document.querySelector('.attachment-chip')?.textContent.includes('分析备注.txt')`,
        );
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[1].click()`);
        await waitForExpression(cdp, `!document.querySelector('.composer')`);
        await waitForExpression(cdp, `document.body.innerText.includes('未入选模型候选')`);

        const trajectoryText = await cdp.evaluate(`document.body.innerText`);
        expect(String(trajectoryText)).toContain('最终选择');
        expect(String(trajectoryText)).toContain('Code CLI / gpt-5.6-sol');
        expect(String(trajectoryText)).toContain('Code CLI / gpt-5.6-terra');
        expect(String(trajectoryText)).toContain('该模型未声明任务所需的 coding 能力');
        expect(String(trajectoryText)).not.toContain('code-cli-5');
        expect(String(trajectoryText)).not.toContain('Codex CLI 被拒绝');
        expect(await cdp.evaluate(
          `document.querySelectorAll('.live-execution-panel .execution-card').length`,
        )).toBe(1);

        await assertThemeReadability(cdp);
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[0].click()`);
        await waitForExpression(
          cdp,
          `document.querySelector('.composer textarea')?.value === '保留的智谱分析草稿'`,
        );
        expect(await cdp.evaluate(
          `document.querySelector('.attachment-chip')?.textContent.includes('分析备注.txt')`,
        )).toBe(true);

        // 固定主题不受系统变化影响，刷新后仍使用 localStorage 中的用户偏好。
        await selectTheme(cdp, '浅色');
        await assertUserMessageReadability(cdp, 'light');
        expect(await cdp.evaluate(`localStorage.getItem('metawork.theme')`)).toBe('light');
        expect(await cdp.evaluate(`localStorage.getItem('anyfusion.theme')`)).toBeNull();
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        });
        await delay(100);
        expect(await cdp.evaluate(`document.documentElement.dataset.theme`)).toBe('light');
        await cdp.send('Page.reload');
        await waitForWorkspace(cdp);
        expect(await cdp.evaluate(`document.documentElement.dataset.theme`)).toBe('light');
        expect(await cdp.evaluate(
          `document.documentElement.dataset.themePreference`,
        )).toBe('light');
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[1].click()`);
        await waitForExpression(cdp, `document.body.innerText.includes('未入选模型候选')`);
        await assertThemeReadability(cdp);
        await assertLightTrajectorySurfaces(cdp);

        await selectTheme(cdp, '深色');
        expect(await cdp.evaluate(`document.documentElement.dataset.theme`)).toBe('dark');
        await assertThemeReadability(cdp);

        await selectTheme(cdp, '跟随系统');
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'light' }],
        });
        await waitForExpression(cdp, `document.documentElement.dataset.theme === 'light'`);
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        });
        await waitForExpression(cdp, `document.documentElement.dataset.theme === 'dark'`);

        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);
        await cdp.evaluate(`document.querySelectorAll('.workspace-tabs button')[0].click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.executor-attempt > header'))`);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await delay(100);
        expect(await cdp.evaluate(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        )).toBe(true);
        expect(await attemptHeaderLayout(cdp)).toMatchObject({
          overflowFree: true,
          labelOverlapsStatus: false,
          statusOverlapsDuration: false,
        });
      } finally {
        cdp.close();
      }
    } finally {
      if (chrome) {
        chrome.kill();
        await new Promise<void>(resolvePromise => {
          if (chrome!.exitCode !== null) {
            resolvePromise();
            return;
          }
          chrome!.once('exit', () => resolvePromise());
        });
      }
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      await server.close();
    }
  }, 60_000);
});

function historicalTurnFixture(): ConversationTurn {
  const raw: ConversationTurn = {
    id: 'turn_routing_theme',
    sessionId: 'session-1',
    userInput: '研究港股智谱股价持续下跌的原因并生成 HTML',
    status: 'completed',
    finalAnswer: '分析与 HTML 已完成。',
    taskId: 'task_live',
    startedAt: '2026-08-25T08:00:00.000Z',
    completedAt: '2026-08-25T08:01:00.000Z',
    traceEvents: [
      {
        id: 'routing-proposal-id',
        sequence: 1,
        occurredAt: '2026-08-25T08:00:01.000Z',
        phase: 'routing',
        actor: 'kernel',
        kind: 'executor_routed',
        status: 'completed',
        title: '已完成模型级路由',
        summary: 'Codex CLI 的 gpt-5.6-sol 候选已获授权。',
        subtaskId: 'research',
        details: {
          subtaskId: 'research',
          subtaskTitle: '研究港股智谱股价持续下跌的原因',
          executorDisplayName: 'Codex CLI',
          harnessDisplayName: 'Codex CLI',
          providerDisplayName: 'Code CLI',
          modelDisplayName: 'gpt-5.6-sol',
        },
      },
      {
        id: 'dependency-blocked',
        sequence: 2,
        occurredAt: '2026-08-25T08:00:02.000Z',
        phase: 'execution',
        actor: 'runtime',
        kind: 'dependency_wait',
        status: 'blocked',
        title: '短暂等待上游事实',
        summary: '等待依赖后已自动恢复，不需要用户重新发起任务。',
        subtaskId: canonicalSubtaskId,
        details: {
          subtaskId: canonicalSubtaskId,
          subtaskTitle: '研究港股智谱股价持续下跌的原因',
        },
      },
      {
        id: 'fallback-failed',
        sequence: 3,
        occurredAt: '2026-08-25T08:00:03.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_result_observed',
        status: 'failed',
        title: '一个未入选候选不可用',
        summary: '候选失败未影响最终授权的 Codex CLI Executor。',
        subtaskId: canonicalSubtaskId,
        details: {
          subtaskId: canonicalSubtaskId,
          subtaskTitle: '研究港股智谱股价持续下跌的原因',
        },
      },
      {
        id: 'execution-runtime-id',
        sequence: 4,
        occurredAt: '2026-08-25T08:00:04.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'completed',
        title: 'Executor 完成研究与 HTML 生成',
        summary: '已核对公告、资金流和估值，并生成可交付 HTML。',
        subtaskId: canonicalSubtaskId,
        details: {
          subtaskId: canonicalSubtaskId,
          subtaskTitle: '研究港股智谱股价持续下跌的原因',
          executorDisplayName: 'Codex CLI',
          harnessDisplayName: 'Codex CLI',
          providerDisplayName: 'Code CLI',
          modelDisplayName: 'gpt-5.6-sol',
          stepLabel: '已生成 HTML',
        },
      },
    ],
    executionTimeline: {
      taskId: 'task_live',
      title: '研究港股智谱股价持续下跌的原因并生成 HTML',
      status: 'done',
      stages: [{
        phase: 'execution',
        status: 'done',
        subtasks: [{
          id: canonicalSubtaskId,
          title: '研究港股智谱股价持续下跌的原因',
          status: 'done',
          executor: 'Codex CLI',
          attempts: [{
            attemptId: longAttemptId,
            attemptKind: 'primary',
            attemptOrdinal: 1,
            attemptLabel: '主执行',
            displayStatus: '已完成',
            result: 'success',
            status: 'terminal',
            startedAt: '2026-08-25T08:00:04.000Z',
            updatedAt: '2026-08-25T08:01:00.000Z',
            progressHistory: [{
              kind: 'status',
              text: '完成原因分析并生成 HTML。',
              occurredAt: '2026-08-25T08:00:55.000Z',
            }],
          }],
        }],
      }],
    },
    artifactRefs: [],
    artifacts: [],
  };
  const aliases = buildCanonicalSubtaskIdentityMap(
    'task_live',
    1,
    [{ id: 'research' }],
  );
  return normalizeExecutionPresentation(raw, aliases);
}

async function startMockServer(webDist: string): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const upgradedSockets = new Set<Socket>();
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
      upgradedSockets.add(socket);
      socket.once('close', () => upgradedSockets.delete(socket));
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const payload = Buffer.from(JSON.stringify({ type: 'hello', sessionId: 'session-1' }));
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      socket.on('error', () => socket.destroy());
    } catch {
      socket.destroy();
    }
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/auth/session') {
      json(response, {
        authenticated: true,
        launchContext: null,
      });
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
          displayName: 'repo-browser-e2e',
          canonicalPath: '/repo-browser-e2e',
          availability: 'available',
          createdAt: '2026-08-25T08:00:00.000Z',
          updatedAt: '2026-08-25T08:01:00.000Z',
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
          title: '路由身份与主题验收',
          createdAt: '2026-08-25T08:00:00.000Z',
          updatedAt: '2026-08-25T08:01:00.000Z',
          active: true,
          archived: false,
          preview: '路由身份与主题验收',
          activity: {
            state: 'idle',
            taskId: null,
            updatedAt: '2026-08-25T08:01:00.000Z',
          },
          workspace: {
            path: '/repo-browser-e2e',
            selectedAt: '2026-08-25T08:00:00.000Z',
          },
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
          title: '路由身份与主题验收',
          createdAt: '2026-08-25T08:00:00.000Z',
          updatedAt: '2026-08-25T08:01:00.000Z',
          active: true,
          archived: false,
          workspace: {
            path: '/repo-browser-e2e',
            selectedAt: '2026-08-25T08:00:00.000Z',
          },
        },
        turns: [historicalTurnFixture()],
      });
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
    if (url.pathname === '/api/attachments' && request.method === 'POST') {
      for await (const _chunk of request) {
        // Consume the upload body before returning its public metadata.
      }
      json(response, {
        attachmentId: 'attachment-browser-test',
        sessionId: 'session-1',
        name: url.searchParams.get('name') ?? 'attachment.txt',
        mime: 'text/plain',
        kind: 'text',
        size: 48,
        sha256: 'sha256:attachment-browser-test',
        createdAt: '2026-08-25T08:00:00.000Z',
      });
      return;
    }
    if (url.pathname === '/api/execution/tasks/task_live/work-graph') {
      json(response, {
        generationId: 'generation-live',
        nodes: [{
          id: canonicalSubtaskId,
          title: '研究港股智谱股价持续下跌的原因',
          goal: '完成研究并生成 HTML',
          status: 'done',
          phase: 0,
          runnable: false,
          dependencies: [],
          requiredCapabilities: ['coding'],
          acceptanceCriteria: ['生成 HTML'],
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
        parallelGroups: [[canonicalSubtaskId]],
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
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      for (const socket of upgradedSockets) socket.destroy();
      server.close(error => error ? rejectPromise(error) : resolvePromise());
    }),
  };
}

async function setFileInputFiles(cdp: CdpClient, path: string): Promise<void> {
  const documentResult = await cdp.send('DOM.getDocument') as {
    root: { nodeId: number };
  };
  const queryResult = await cdp.send('DOM.querySelector', {
    nodeId: documentResult.root.nodeId,
    selector: '.composer input[type="file"]',
  }) as { nodeId: number };
  if (!queryResult.nodeId) throw new Error('composer file input was not found');
  await cdp.send('DOM.setFileInputFiles', {
    nodeId: queryResult.nodeId,
    files: [path],
  });
}

async function selectTheme(cdp: CdpClient, label: string): Promise<void> {
  await cdp.evaluate(`
    [...document.querySelectorAll('.theme-control button')]
      .find(button => button.textContent === ${JSON.stringify(label)}).click()
  `);
  await waitForExpression(
    cdp,
    `document.querySelector('.theme-control button[data-active="true"]')?.textContent === ${JSON.stringify(label)}`,
  );
}

async function assertThemeReadability(cdp: CdpClient): Promise<void> {
  const audit = await cdp.evaluate(`(() => {
    const parse = value => {
      if (value.startsWith('#')) {
        const hex = value.slice(1);
        const normalized = hex.length === 3
          ? [...hex].map(character => character + character).join('')
          : hex;
        return [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16));
      }
      const match = value.match(/[\\d.]+/g);
      return match ? match.slice(0, 3).map(Number) : null;
    };
    const luminance = rgb => {
      const values = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const contrast = (foreground, background) => {
      const left = luminance(parse(foreground));
      const right = luminance(parse(background));
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const root = getComputedStyle(document.documentElement);
    const surface = root.getPropertyValue('--surface-raised').trim();
    const tokens = ['--text-primary', '--status-warning', '--status-danger', '--focus-ring'];
    const ratios = Object.fromEntries(tokens.map(token => [
      token,
      contrast(root.getPropertyValue(token).trim(), surface),
    ]));
    const routing = document.querySelector('.routing-decision-card');
    const warning = document.querySelector('.routing-rejections');
    const blocked = document.querySelector('.trajectory-event [data-status="blocked"]');
    const failed = document.querySelector('.trajectory-event [data-status="failed"]');
    const focusTarget = document.querySelector('.theme-control button');
    focusTarget.focus({ focusVisible: true });
    const focusStyle = getComputedStyle(focusTarget);
    return {
      ratios,
      visible: [routing, warning, blocked, failed].every(element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
      focusOutlineWidth: Number.parseFloat(focusStyle.outlineWidth),
      focusOutlineStyle: focusStyle.outlineStyle,
    };
  })()`);
  const result = audit as {
    ratios: Record<string, number>;
    visible: boolean;
    focusOutlineWidth: number;
    focusOutlineStyle: string;
  };
  expect(result.visible).toBe(true);
  expect(result.ratios['--text-primary']).toBeGreaterThanOrEqual(7);
  expect(result.ratios['--status-warning']).toBeGreaterThanOrEqual(3);
  expect(result.ratios['--status-danger']).toBeGreaterThanOrEqual(3);
  expect(result.ratios['--focus-ring']).toBeGreaterThanOrEqual(3);
  expect(result.focusOutlineWidth).toBeGreaterThanOrEqual(2);
  expect(result.focusOutlineStyle).not.toBe('none');
}

async function assertUserMessageReadability(
  cdp: CdpClient,
  expectedTheme: 'light' | 'dark',
): Promise<void> {
  const audit = await cdp.evaluate(`(() => {
    const parse = value => {
      const match = value.match(/[\\d.]+/g);
      return match ? match.slice(0, 3).map(Number) : null;
    };
    const luminance = rgb => {
      const values = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const message = document.querySelector('.user-message');
    const paragraph = message.querySelector('p');
    const messageStyle = getComputedStyle(message);
    const paragraphStyle = getComputedStyle(paragraph);
    const foreground = luminance(parse(paragraphStyle.color));
    const background = luminance(parse(messageStyle.backgroundColor));
    return {
      contrast: (Math.max(foreground, background) + 0.05)
        / (Math.min(foreground, background) + 0.05),
      backgroundLuminance: background,
    };
  })()`) as {
    contrast: number;
    backgroundLuminance: number;
  };
  expect(audit.contrast).toBeGreaterThanOrEqual(4.5);
  if (expectedTheme === 'light') {
    expect(audit.backgroundLuminance).toBeGreaterThanOrEqual(0.65);
  } else {
    expect(audit.backgroundLuminance).toBeLessThanOrEqual(0.05);
  }
}

async function assertLightTrajectorySurfaces(cdp: CdpClient): Promise<void> {
  const audit = await cdp.evaluate(`(() => {
    const parse = value => {
      const match = value.match(/[\\d.]+/g);
      return match ? match.slice(0, 3).map(Number) : null;
    };
    const luminance = rgb => {
      const values = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const selectors = [
      '.trajectory-summary',
      '.trajectory-band',
      '.trajectory-filters input',
      '.trajectory-filters select',
      '.trajectory-head',
    ];
    const results = selectors.flatMap(selector => (
      [...document.querySelectorAll(selector)].map((element, index) => {
        const style = getComputedStyle(element);
        const background = luminance(parse(style.backgroundColor));
        const foreground = luminance(parse(style.color));
        return {
          selector: selector + ':' + index,
          background,
          contrast: (Math.max(foreground, background) + 0.05)
            / (Math.min(foreground, background) + 0.05),
        };
      })
    ));
    const firstEvent = document.querySelector('.trajectory-event');
    firstEvent.open = true;
    const detail = firstEvent.querySelector('pre');
    const detailStyle = getComputedStyle(detail);
    const detailBackground = luminance(parse(detailStyle.backgroundColor));
    const detailForeground = luminance(parse(detailStyle.color));
    results.push({
      selector: '.trajectory-event pre',
      background: detailBackground,
      contrast: (Math.max(detailForeground, detailBackground) + 0.05)
        / (Math.min(detailForeground, detailBackground) + 0.05),
    });
    return results;
  })()`) as Array<{
    selector: string;
    background: number;
    contrast: number;
  }>;

  for (const surface of audit) {
    expect(surface.background, surface.selector).toBeGreaterThanOrEqual(0.65);
    expect(surface.contrast, surface.selector).toBeGreaterThanOrEqual(4.5);
  }
}

async function attemptHeaderLayout(cdp: CdpClient): Promise<{
  overflowFree: boolean;
  labelOverlapsStatus: boolean;
  statusOverlapsDuration: boolean;
}> {
  return cdp.evaluate(`(() => {
    const header = document.querySelector('.executor-attempt > header');
    const label = document.querySelector('.executor-attempt-label');
    const status = document.querySelector('.executor-attempt-status');
    const duration = document.querySelector('.executor-attempt-duration');
    const overlaps = (left, right) => (
      left.left < right.right
      && left.right > right.left
      && left.top < right.bottom
      && left.bottom > right.top
    );
    const headerRect = header.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const durationRect = duration.getBoundingClientRect();
    return {
      overflowFree: header.scrollWidth <= header.clientWidth
        && headerRect.right <= window.innerWidth,
      labelOverlapsStatus: overlaps(labelRect, statusRect),
      statusOverlapsDuration: overlaps(statusRect, durationRect),
    };
  })()`) as Promise<{
    overflowFree: boolean;
    labelOverlapsStatus: boolean;
    statusOverlapsDuration: boolean;
  }>;
}

async function waitForWorkspace(cdp: CdpClient): Promise<void> {
  await waitForExpression(cdp, `Boolean(document.querySelector('.workspace-shell'))`);
  await waitForExpression(
    cdp,
    `document.querySelectorAll('.live-execution-panel .execution-card').length === 1`,
  );
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
      if (chrome.exitCode !== null) {
        stderrStream?.off('data', onStderr);
        throw new Error(`Chrome exited before creating a DevTools port:\n${stderr}`);
      }
      await delay(50);
    }
  }
  stderrStream?.off('data', onStderr);
  throw new Error(`Chrome DevTools port was not created:\n${stderr}`);
}

async function waitForPageTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(response => response.json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
      const page = targets.find(target => target.type === 'page');
      if (page) return page;
    } catch {
      // Chrome may advertise the port before its target endpoint is ready.
    }
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
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener(
        'error',
        () => rejectPromise(new Error('CDP WebSocket failed')),
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
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

  close(): void {
    this.socket.close();
  }
}

async function waitForExpression(cdp: CdpClient, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {
      // The application may still be replacing its initial DOM.
    }
    await delay(50);
  }
  const snapshot = await cdp.evaluate(
    `JSON.stringify({
      body: document.body.innerText.slice(0, 500),
      root: document.getElementById('root')?.innerHTML.slice(0, 500),
    })`,
  );
  throw new Error(`browser condition timed out: ${expression}\npage: ${snapshot}`);
}
