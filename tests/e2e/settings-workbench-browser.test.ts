import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { buildExecutorConfigurationCandidate, parseExecutorConfigurationChange, projectExecutorManagement } from '../../src/configuration/executor-configuration.js';
import { buildExecutorManualPreview } from '../../src/configuration/projections.js';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runBrowserE2e = process.env.RUN_BROWSER_E2E === '1';
const e2e = runBrowserE2e ? describe : describe.skip;

e2e('Settings workbench browser flow', () => {
  it('finishes activation without another public catalog request', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const server = await startMockServer(join(root, 'web', 'dist'));
    const profile = await mkdtemp(join(tmpdir(), 'settings-local-save-'));
    const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.port}/`], { stdio: 'ignore' });
    try {
      const target = await waitForPageTarget(await waitForDebuggingPort(profile));
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`(() => {
          const original = window.fetch.bind(window);
          window.completionCalls = 0;
          window.fetch = (url, options) => {
            if (String(url).endsWith('/api/config/completion') && ++window.completionCalls > 1) {
              return new Promise(() => {});
            }
            return original(url, options);
          };
          document.querySelector('.sidebar-settings').click();
        })()`);
        await waitForExpression(cdp, `document.querySelectorAll('.provider-card').length > 0`);
        await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存并激活').click()`);
        await waitForExpression(cdp, `document.body.innerText.includes('配置已热激活') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存并激活')`);
        expect(await cdp.evaluate('window.completionCalls')).toBe(1);
        expect(server.getActivationPayload()).not.toBeNull();
      } finally { cdp.close(); }
    } finally {
      chrome.kill('SIGTERM'); await server.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('shows complete natural-language model evidence on desktop and mobile without routing tags', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const server = await startMockServer(join(root, 'web', 'dist'));
    const profile = await mkdtemp(join(tmpdir(), 'settings-model-evidence-'));
    const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.port}/`], { stdio: 'ignore' });
    try {
      const target = await waitForPageTarget(await waitForDebuggingPort(profile));
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await cdp.send('Page.enable');
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`(() => {
          const original = window.fetch.bind(window);
          window.fetch = async (url, options) => {
            const response = await original(url, options);
            if (!String(url).endsWith('/api/config')) return response;
            const data = await response.json();
            const model = data.config.models['code-gpt-56'];
            model.routingNotes = {
              summary: '适合跨文件工程修改与测试设计，能够关联改动影响并规划验证步骤。',
              strengths: ['能够结合调用关系定位修改范围，处理多个文件之间的依赖。'],
              preferredTaskTypes: ['需要兼顾接口兼容性和回归验证的代码重构。'],
              limitations: ['安全敏感修改仍需要专项检查，公开资料不能保证测试覆盖完整。'],
              avoidTaskTypes: ['需要未经授权的生产环境操作的任务。']
            };
            model.description = '公开能力说明用于比较任务适配。';
            model.publicFacts = {inputModalities:['text'], outputModalities:['text'], supportedParameters:['tools'], highlights:[]};
            return new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
          };
          document.querySelector('.sidebar-settings').click();
        })()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.provider-collapse-toggle'))`);
        await cdp.evaluate(`document.querySelector('.provider-collapse-toggle').click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.model-edit-button'))`);
        await cdp.evaluate(`document.querySelector('.model-edit-button').click()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.model-capability-details'))`);
        const text = await cdp.evaluate(`document.querySelector('.model-edit-panel').innerText`) as string;
        for (const label of ['具体优势', '适合的任务', '能力局限', '不适合的任务', '公开能力说明用于比较任务适配', '输入', '输出']) expect(text).toContain(label);
        expect(text).not.toContain('路由标签');
        expect(text).not.toContain('路由能力（用于智能路由）');
        expect(await cdp.evaluate(`document.querySelectorAll('.model-edit-panel .fact-chip').length`)).toBe(0);
        expect(text).not.toContain('不参与路由');
        for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
          await cdp.evaluate(`document.querySelector('.model-capability-details').scrollIntoView({block:'center'})`);
          expect(await cdp.evaluate(`(() => {
            const element = document.querySelector('.model-capability-details');
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
          })()`)).toBe(true);
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
          await writeFile(join(tmpdir(), `metawork-description-routing-${name}.png`), Buffer.from(screenshot.data, 'base64'));
        }
        expect(server.getActivationPayload()).toBeNull();
      } finally { cdp.close(); }
    } finally {
      chrome.kill('SIGTERM'); await server.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('reports AI loading, changed, unchanged and failed outcomes without overwriting concurrent edits', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const server = await startMockServer(join(root, 'web', 'dist'));
    const profile = await mkdtemp(join(tmpdir(), 'settings-ai-feedback-'));
    const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.port}/`], { stdio: 'ignore' });
    try {
      const target = await waitForPageTarget(await waitForDebuggingPort(profile));
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`(() => {
          const original = window.fetch.bind(window);
          window.aiPending = {};
          window.fetch = (url, options) => {
            const path = String(url);
            const kind = path.endsWith('/agent-responsibility') ? 'rewrite' : path.endsWith('/agent-capabilities') ? 'capability' : null;
            if (!kind) return original(url, options);
            return new Promise(resolve => { window.aiPending[kind] = (body, status = 200) => {
              delete window.aiPending[kind];
              resolve(new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}));
            }; });
          };
          window.setDuty = text => {
            const field = document.querySelector('.agent-responsibility-input');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, text);
            field.dispatchEvent(new Event('input', {bubbles:true}));
          };
          document.querySelector('.sidebar-settings').click();
        })()`);
        await waitForExpression(cdp, `Boolean([...document.querySelectorAll('.agent-summary-toggle')].find(b => b.textContent.includes('Executor')))`);
        await cdp.evaluate(`[...document.querySelectorAll('.agent-summary-toggle')].find(b => b.textContent.includes('Executor')).click()`);
        await waitForExpression(cdp, `Boolean(window.aiPending.capability)`);
        const first = { summary: '该智能体可分析代码。', abilities: [{ title: '代码分析', description: '梳理调用关系。' }], boundaries: [] };
        const second = { ...first, summary: '该智能体可分析代码与测试结果。' };
        const capability = `document.querySelector('.agent-capability-profile')`;
        const duty = `document.querySelector('.agent-responsibility-panel')`;
        await cdp.evaluate(`window.aiPending.capability(${JSON.stringify(first)})`);
        await waitForExpression(cdp, `${capability}.innerText.includes('能力说明已就绪')`);
        await cdp.evaluate(`${capability}.querySelector('button').click()`);
        await waitForExpression(cdp, `${capability}.innerText.includes('更新前说明') && Boolean(window.aiPending.capability)`);
        await cdp.evaluate(`window.aiPending.capability(${JSON.stringify(second)})`);
        await waitForExpression(cdp, `${capability}.innerText.includes('能力更新成功')`);
        expect(await cdp.evaluate(`${capability}.querySelector('.agent-capability-summary').textContent`)).toBe(second.summary);
        expect(await cdp.evaluate(`${capability}.querySelector('details').textContent`)).toContain(first.summary);
        await cdp.evaluate(`${capability}.querySelector('button').click()`);
        await waitForExpression(cdp, `Boolean(window.aiPending.capability)`);
        await cdp.evaluate(`window.aiPending.capability(${JSON.stringify(second)})`);
        await waitForExpression(cdp, `${capability}.innerText.includes('已检查，内容无变化')`);
        await cdp.evaluate(`${capability}.querySelector('button').click()`);
        await waitForExpression(cdp, `Boolean(window.aiPending.capability)`);
        await cdp.evaluate(`window.aiPending.capability({error:'服务暂不可用'}, 503)`);
        await waitForExpression(cdp, `${capability}.innerText.includes('能力更新失败')`);
        expect(await cdp.evaluate(`${capability}.querySelector('.agent-capability-summary').textContent`)).toBe(second.summary);

        const rewrite = async () => {
          await cdp.evaluate(`${duty}.querySelector('button').click()`);
          await waitForExpression(cdp, `Boolean(window.aiPending.rewrite)`);
        };
        await cdp.evaluate(`window.setDuty('代码与项目测试')`);
        await rewrite();
        expect(await cdp.evaluate(`${duty}.innerText`)).toContain('改写前内容');
        const response = { sourceText: '代码与项目测试', suggestedText: '负责代码实现与回归测试，交付代码修改和验证结果。', requiresConfirmation: true, selectedModelRefs: [], evidence: [] };
        await cdp.evaluate(`window.aiPending.rewrite(${JSON.stringify(response)})`);
        await waitForExpression(cdp, `${duty}.innerText.includes('AI 改写成功')`);
        expect(await cdp.evaluate(`${duty}.querySelector('textarea').value`)).toBe(response.suggestedText);
        expect(await cdp.evaluate(`${duty}.querySelector('details').textContent`)).toContain('代码与项目测试');
        await rewrite();
        await cdp.evaluate(`window.aiPending.rewrite(${JSON.stringify(response)})`);
        await waitForExpression(cdp, `${duty}.innerText.includes('已检查，内容无变化')`);
        await rewrite();
        await cdp.evaluate(`window.aiPending.rewrite({error:'AI 改写超时'}, 504)`);
        await waitForExpression(cdp, `${duty}.innerText.includes('改写失败')`);
        expect(await cdp.evaluate(`${duty}.querySelector('textarea').value`)).toBe(response.suggestedText);
        await rewrite();
        await cdp.evaluate(`window.setDuty('用户正在编辑的新职责')`);
        await cdp.evaluate(`window.aiPending.rewrite(${JSON.stringify(response)})`);
        await waitForExpression(cdp, `${duty}.innerText.includes('本次建议未应用')`);
        expect(await cdp.evaluate(`${duty}.querySelector('textarea').value`)).toBe('用户正在编辑的新职责');
        expect(server.getActivationPayload()).toBeNull();
      } finally { cdp.close(); }
    } finally {
      chrome.kill('SIGTERM'); await server.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('saves the Span key separately, clears it, and retains the stored key when disabled', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const server = await startMockServer(join(root, 'web', 'dist'));
    const profile = await mkdtemp(join(tmpdir(), 'span-settings-chrome-'));
    const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.port}/`], { stdio: 'ignore' });
    try {
      const target = await waitForPageTarget(await waitForDebuggingPort(profile));
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`document.querySelector('.sidebar-settings').click()`);
        await waitForExpression(cdp, `[...document.querySelectorAll('h3')].some(h => h.textContent === '决策模型')`);
        await cdp.evaluate(`window.spanSection = () => [...document.querySelectorAll('h3')].find(h => h.textContent === '决策模型').closest('section')`);
        await cdp.evaluate(`window.spanSection().closest('details').open = true`);
        // The credential field only exists while the advisor is enabled.
        await waitForExpression(cdp, `!window.spanSection().querySelector('input[type=password]')`);
        await cdp.evaluate(`window.spanSection().querySelector('input[type=checkbox]').click()`);
        await waitForExpression(cdp, `Boolean(window.spanSection().querySelector('input[type=password]'))`);
        await cdp.evaluate(`(() => {
          const key = window.spanSection().querySelector('input[type=password]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(key, 'browser-span-test-key');
          key.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const save = async () => {
          await waitForExpression(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存并激活' && !b.disabled)`);
          await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存并激活').click()`);
        };
        await save();
        await waitForExpression(cdp, `(() => { const key = window.spanSection().querySelector('input[type=password]'); return Boolean(key) && key.value === '' && key.placeholder.includes('已配置'); })()`);
        const first = server.getActivationPayload() as any;
        expect(first.spanApiKey).toBe('browser-span-test-key');
        expect(first.config.routing.span.enabled).toBe(true);
        expect(JSON.stringify(first.config)).not.toContain('browser-span-test-key');
        expect(JSON.stringify(first.secrets)).not.toContain('browser-span-test-key');
        await cdp.evaluate(`window.spanSection().querySelector('input[type=checkbox]').click()`);
        await save();
        for (let attempt = 0; attempt < 100 && server.getActivationPayload() === first; attempt += 1) await delay(50);
        expect(server.getActivationPayload()).not.toBe(first);
        await waitForExpression(cdp, `!window.spanSection().querySelector('input[type=checkbox]').checked && !window.spanSection().querySelector('input[type=password]')`);
        const second = server.getActivationPayload() as any;
        expect(second.spanApiKey).toBeUndefined();
        expect(second.config.routing.span).toMatchObject({ enabled: false,
          apiKeyRef: 'file-secret:anyfusion/internal/routing-span' });
      } finally { cdp.close(); }
    } finally {
      chrome.kill('SIGTERM'); await server.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('creates, renames, disables, enables and deletes an assistant, and blocks busy editing on mobile', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const server = await startMockServer(join(root, 'web', 'dist'), 'executor-management');
    const profile = await mkdtemp(join(tmpdir(), 'metawork-executor-chrome-'));
    let chrome: ChildProcess | null = null;
    try {
      chrome = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--window-size=1440,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        `http://127.0.0.1:${server.port}/`,
      ], { stdio: 'ignore' });
      const target = await waitForPageTarget(await waitForDebuggingPort(profile));
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        const click = async (label: string, selector = 'button') => {
          await waitForExpression(cdp, `[...document.querySelectorAll(${JSON.stringify(selector)})].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`);
          await cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
        };
        const save = async () => {
          await click('预览变更', '.executor-editor-dialog button');
          await click('确认并热生效', '.executor-editor-dialog button');
          await waitForExpression(cdp, `!document.querySelector('.executor-editor-dialog')`);
        };
        await waitForExpression(cdp, `Boolean(document.querySelector('.sidebar-settings'))`);
        await cdp.evaluate(`document.querySelector('.sidebar-settings').click()`);
        await click('新增智能体');
        await waitForExpression(cdp, `Boolean(document.querySelector('.executor-editor-dialog'))`);
        await cdp.evaluate(`(() => {
          const form = document.querySelector('.executor-editor-dialog');
          const name = form.querySelector('input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Browser assistant');
          name.dispatchEvent(new Event('input', { bubbles: true }));
          const model = form.querySelectorAll('select')[2];
          model.value = model.options[1].value;
          model.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await save();
        await waitForExpression(cdp, `document.querySelectorAll('.agent-summary-toggle').length === 4`);
        await cdp.evaluate(`(() => {
          const button = [...document.querySelectorAll('.agent-summary-toggle')].find(b => b.textContent.includes('Browser assistant'));
          window.browserAgentId = button.getAttribute('aria-controls');
          button.click();
        })()`);
        await waitForExpression(cdp, `Boolean(document.getElementById(window.browserAgentId))`);
        const action = async (label: string) => {
          await waitForExpression(cdp, `(() => {
            const row = document.getElementById(window.browserAgentId).parentElement.querySelector('.executor-management-actions');
            return [...row.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
          })()`);
          await cdp.evaluate(`(() => {
            const row = document.getElementById(window.browserAgentId).parentElement.querySelector('.executor-management-actions');
            [...row.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click();
          })()`);
          await waitForExpression(cdp, `Boolean(document.querySelector('.executor-editor-dialog'))`);
        };
        await action('编辑智能体');
        await cdp.evaluate(`(() => {
          const name = document.querySelector('.executor-editor-dialog input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Renamed assistant');
          name.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await save();
        await cdp.evaluate(`(() => {
          const card = document.getElementById(window.browserAgentId).querySelector('.agent-route-card');
          const name = card.querySelector('.agent-name-field input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Unsaved local name');
          name.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitForExpression(cdp, `document.getElementById(window.browserAgentId).querySelector('.agent-name-field input').value === 'Unsaved local name'`);
        const unsavedModel = await cdp.evaluate(`(() => {
          const card = document.getElementById(window.browserAgentId).querySelector('.agent-route-card');
          const model = [...card.querySelectorAll('select')].at(-1);
          const alternative = [...model.options].find(option => option.value && !option.disabled && option.value !== model.value);
          if (!alternative) throw new Error('Expected an alternate model');
          model.value = alternative.value;
          model.dispatchEvent(new Event('change', { bubbles: true }));
          return model.value;
        })()`);
        await action('停用');
        await save();
        await waitForExpression(cdp, `document.getElementById(window.browserAgentId).parentElement.querySelector('.executor-management-actions').textContent.includes('已停用')`);
        expect(await cdp.evaluate(`document.getElementById(window.browserAgentId).querySelector('.agent-name-field input').value`))
          .toBe('Unsaved local name');
        expect(await cdp.evaluate(`[...document.getElementById(window.browserAgentId).querySelector('.agent-route-card').querySelectorAll('select')].at(-1).value`))
          .toBe(unsavedModel);
        await action('启用');
        await save();
        expect(await cdp.evaluate(`document.getElementById(window.browserAgentId).querySelector('.agent-name-field input').value`))
          .toBe('Unsaved local name');
        await action('删除');
        await save();
        await waitForExpression(cdp, `document.querySelectorAll('.agent-summary-toggle').length === 3`);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await click('新增智能体');
        await waitForExpression(cdp, `Boolean(document.querySelector('.executor-editor-dialog'))`);
        expect(await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
        server.setBusy(true);
        await waitForExpression(cdp, `document.querySelector('.executor-editor-dialog button[type=submit]').disabled`);
        expect(await cdp.evaluate(`document.querySelector('.executor-editor-dialog input').closest('fieldset').disabled`)).toBe(true);
        server.setBusy(false);
        await waitForExpression(cdp, `!document.querySelector('.executor-editor-dialog button[type=submit]').disabled`);
      } finally { cdp.close(); }
    } finally {
      chrome?.kill('SIGTERM');
      await server.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

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
        await waitForExpression(cdp, `document.querySelectorAll('.agent-summary-toggle').length === 3`);
        expect(await cdp.evaluate(`document.querySelectorAll('.agent-route-card').length`)).toBe(0);
        expect(await cdp.evaluate(`document.querySelectorAll('.provider-card-expanded-body').length`)).toBe(0);
        await cdp.evaluate(`document.querySelectorAll('.agent-summary-toggle, .provider-collapse-toggle').forEach(b => b.click())`);
        await waitForExpression(
          cdp,
          `document.querySelectorAll('.provider-card').length === 2
            && document.querySelectorAll('.agent-route-card').length === 3
            && !document.querySelector('.advanced-settings')?.hasAttribute('open')`,
        );

        const initial = await cdp.evaluate(`(() => {
          const panel = document.querySelector('.settings-workbench');
          return {
            overflowFree: document.documentElement.scrollWidth <= window.innerWidth,
            viewportWidth: window.innerWidth,
            panelFits: panel.getBoundingClientRect().right <= window.innerWidth
              && panel.getBoundingClientRect().left >= 0,
            providerCards: document.querySelectorAll('.provider-card').length,
            routeCards: document.querySelectorAll('.agent-route-card').length,
            hasRoutingExplanation: document.body.innerText.includes('任务要求和成本选择更合适的模型'),
            hasCandidateRejection: document.body.innerText.includes('排除 · 缺少'),
            hasAgentSection: document.body.innerText.includes('智能体'),
            advancedCollapsed: !document.querySelector('.advanced-settings')?.hasAttribute('open'),
            diagnosticsHidden: !document.querySelector('.diagnostics-panel'),
            workspaceHeader: document.querySelector('.workspace-runtime')?.textContent ?? '',
          };
        })()`);
        expect(initial).toMatchObject({
          overflowFree: true,
          viewportWidth: 1440,
          panelFits: true,
          providerCards: 2,
          routeCards: 3,
          hasRoutingExplanation: true,
          hasCandidateRejection: true,
          hasAgentSection: true,
          advancedCollapsed: true,
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
            modelIds: [...providerCard.querySelectorAll('.configured-models-list .model-primary-fact > small.mono')]
              .map(item => item.textContent),
            hasModelFacts: Boolean(document.querySelector('.provider-card')),
          };
        })()`);
        expect(providerDirectory).toEqual({
          modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          hasModelFacts: true,
        });

        const pool = await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll('.agent-route-card')]
            .find(item => item.querySelector('.model-option'));
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
          const card = [...document.querySelectorAll('.agents-section .agent-route-card:not(:has(.agent-fixed-responsibility))')].at(-1);
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
          && [...document.querySelectorAll('.provider-card button:not(.provider-collapse-toggle)')]
            .every(button => button.disabled)
        `);
        const busyControls = await cdp.evaluate(`(() => ({
          saveDisabled: document.querySelector('.drawer-footer .primary-button').disabled,
          deleteDisabled: [...document.querySelectorAll('.provider-card button:not(.provider-collapse-toggle)')]
            .every(button => button.disabled),
        }))()`);
        expect(busyControls).toEqual({ saveDisabled: true, deleteDisabled: true });
        server.setBusy(false);
        await waitForExpression(cdp, `
          !document.querySelector('.drawer-footer .primary-button').disabled
        `);

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
        expect(activated.config?.agentClasses?.['pi-research']?.modelPolicy).toEqual({
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

  it('restores credentialed discovered Providers without duplicating the active Kimi endpoint', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const webDist = join(root, 'web', 'dist');
    await stat(join(webDist, 'index.html'));
    const server = await startMockServer(webDist, 'provider-recovery');
    const profile = await mkdtemp(join(tmpdir(), 'metawork-provider-recovery-chrome-'));
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
        await waitForExpression(
          cdp,
          `document.querySelectorAll('.provider-card').length === 3`,
        );

        const providers = await cdp.evaluate(`(() => (
          [...document.querySelectorAll('.provider-card')].map(card => ({
            name: card.querySelector('h4')?.textContent ?? '',
            baseUrl: card.querySelector('.mono')?.textContent ?? '',
            credentialConfigured: card.textContent.includes('已配置'),
          }))
        ))()`) as Array<{
          name: string;
          baseUrl: string;
          credentialConfigured: boolean;
        }>;
        expect(providers.map(provider => provider.name).sort()).toEqual([
          'Code CLI',
          'DeepSeek',
          'Kimi',
        ]);
        expect(providers.filter(provider => provider.name === 'Kimi')).toHaveLength(1);
        expect(providers.every(provider => provider.credentialConfigured)).toBe(true);
        expect(providers.map(provider => provider.baseUrl).sort()).toEqual([
          'https://api.deepseek.com/v1',
          'https://api.kimi.com/coding/v1',
          'https://www.code-cli.cn/v1',
        ]);

        await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll('.provider-card')]
            .find(item => item.querySelector('h4')?.textContent === 'DeepSeek');
          card.querySelector('.provider-collapse-toggle').click();
        })()`);
        await waitForExpression(cdp, `Boolean(document.querySelector('.discovered-model-row'))`);
        await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll('.provider-card')]
            .find(item => item.querySelector('h4')?.textContent === 'DeepSeek');
          const line = [...card.querySelectorAll('.discovered-model-row')]
            .find(item => item.querySelector('small.mono')?.textContent === 'deepseek-chat');
          line.querySelector('button').click();
          document.querySelectorAll('.agent-summary-toggle').forEach(b => b.click());
        })()`);
        await waitForExpression(cdp, `document.querySelectorAll('.agent-route-card').length === 3`);
        await cdp.evaluate(`(() => {
          for (const routeCard of document.querySelectorAll('.agents-section .agent-route-card:not(:has(.agent-fixed-responsibility))')) {
            const mode = routeCard.querySelector('.route-policy-heading select');
            mode.value = 'auto';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
        await waitForExpression(cdp, `
          [...document.querySelectorAll('.agents-section .agent-route-card:not(:has(.agent-fixed-responsibility))')].every(card => {
            return [...card.querySelectorAll('.model-option')].some(
              option => option.textContent.includes('deepseek-chat')
            );
          })
        `);
        const deepseekEligibility = await cdp.evaluate(`(() => {
          const routeCards = [...document.querySelectorAll('.agents-section .agent-route-card:not(:has(.agent-fixed-responsibility))')];
          const eligibilityFor = card => {
            const option = [...card.querySelectorAll('.model-option')]
              .find(item => item.textContent.includes('deepseek-chat'));
            return {
              disabled: option.querySelector('input').disabled,
              detail: option.textContent,
            };
          };
          return {
            codex: eligibilityFor(routeCards[0]),
            pi: eligibilityFor(routeCards[1]),
          };
        })()`) as {
          codex: { disabled: boolean; detail: string };
          pi: { disabled: boolean; detail: string };
        };
        expect(deepseekEligibility.codex.disabled).toBe(true);
        expect(deepseekEligibility.codex.detail).toContain('缺少 gpt-family');
        expect(deepseekEligibility.pi.disabled).toBe(false);
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
}>;
async function startMockServer(webDist: string, mode: 'provider-recovery' | 'executor-management'): Promise<{
  port: number; close(): Promise<void>; getActivationPayload(): unknown; setBusy(value: boolean): void;
}>;
async function startMockServer(
  webDist: string,
  mode?: 'provider-recovery' | 'executor-management',
): Promise<{
  port: number;
  close(): Promise<void>;
  getActivationPayload(): unknown;
  setBusy(value: boolean): void;
}> {
  let activationPayload: unknown = null;
  let spanRouting: any = undefined;
  let spanConfigured = false;
  let busy = false;
  let executorSnapshot = buildStagedLegacyConfiguration({ testMode: true }).snapshot;
  if (mode === 'executor-management') {
    for (const [ref, model] of Object.entries(executorSnapshot.config.models)) {
      executorSnapshot.config.models[`${ref}-alternate`] = {
        ...model, modelId: `${model.modelId}-alternate`,
      };
    }
  }
  let activationOrdinal = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (mode === 'executor-management') {
      if (url.pathname === '/api/config') {
        json(response, { ...executorSnapshot, runningRevisionId: executorSnapshot.revisionId });
        return;
      }
      if (url.pathname === '/api/config/executors') {
        json(response, projectExecutorManagement(executorSnapshot));
        return;
      }
      if (url.pathname === '/api/config/executors/prepare') {
        void readJsonBody(request).then(body => {
          json(response, buildExecutorConfigurationCandidate(executorSnapshot, parseExecutorConfigurationChange(body.change)));
        });
        return;
      }
      const manual = /^\/api\/config\/executors\/([^/]+)\/capability-manual(?:\/compile)?$/u.exec(url.pathname);
      if (manual) {
        if (request.method === 'POST') {
          void readJsonBody(request).then(body => {
            const snapshot = { ...executorSnapshot, config: body.config as typeof executorSnapshot.config };
            json(response, { config: snapshot.config, manual: buildExecutorManualPreview(snapshot, manual[1]),
              sourceText: '', analysisMode: 'semantic', userProfile: { sourceText: '', assertions: [] } });
          });
        } else json(response, buildExecutorManualPreview(executorSnapshot, manual[1]));
        return;
      }
      if (url.pathname === '/api/config/activate') {
        void readJsonBody(request).then(body => {
          activationPayload = body;
          executorSnapshot = { ...executorSnapshot, config: body.config as typeof executorSnapshot.config,
            revisionId: `executor-browser-${++activationOrdinal}` };
          json(response, { ok: true, revisionId: executorSnapshot.revisionId });
        });
        return;
      }
    }
    if (url.pathname === '/api/auth/session') {
      json(response, { authenticated: true, launchContext: null });
      return;
    }
    if (url.pathname === '/api/ws/diagnostics') {
      json(response, { ok: false, reason: 'test', message: 'WebSocket disabled in browser fixture' });
      return;
    }
    if (url.pathname === '/api/workspaces') {
      json(response, {
        activeWorkspaceId: 'workspace-1',
        workspaces: [{
          id: 'workspace-1',
          accountId: 'local-default',
          displayName: 'settings-workspace',
          canonicalPath: '/repo-settings',
          availability: 'available',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
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
          title: 'Settings verification',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
          active: true,
          archived: false,
          preview: 'Settings verification',
          activity: {
            state: 'idle',
            taskId: null,
            updatedAt: '2026-08-23T00:00:00.000Z',
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
          title: 'Settings verification',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
          active: true,
          archived: false,
          workspace: null,
        },
        turns: [],
      });
      return;
    }
    if (url.pathname === '/api/config/routing/span/status') {
      json(response, { configured: spanConfigured }); return;
    }
    if (url.pathname === '/api/config/activation-status') {
      json(response, busy ? busyActivationState() : activationState());
      return;
    }
    if (url.pathname === '/api/config/secrets/status') {
      json(response, mode === 'provider-recovery'
        ? {
          provider: { configured: true, maskedApiKey: '••••••••kimi', credentialFingerprint: 'sha256:kimi-fixture' },
          'code-cli': { configured: true, maskedApiKey: '••••••••code' },
          deepseek: { configured: true, maskedApiKey: '••••••••seek' },
          kimi: { configured: true, maskedApiKey: '••••••••kimi', credentialFingerprint: 'sha256:kimi-fixture' },
        }
        : {
          'code-cli': { configured: true, maskedApiKey: '••••••••code' },
          deepseek: { configured: true, maskedApiKey: '••••••••seek' },
        });
      return;
    }
    if (url.pathname === '/api/config/completion') {
      json(response, mode === 'provider-recovery' ? providerRecoveryCompletion() : {
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
      json(response, mode === 'provider-recovery'
        ? providerRecoveryConfiguration()
        : { ...configuration(), ...(spanRouting ? { config: { ...configuration().config, routing: spanRouting } } : {}) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/activate') {
      void readJsonBody(request).then(body => {
        activationPayload = body;
        if (body.spanApiKey) spanConfigured = true;
        spanRouting = (body.config as any)?.routing;
        if (spanRouting?.span && spanConfigured) {
          spanRouting = structuredClone(spanRouting);
          spanRouting.span.apiKeyRef = 'file-secret:anyfusion/internal/routing-span';
        }
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

function providerRecoveryCompletion() {
  return {
    providers: {
      'code-cli': {
        displayName: 'Code CLI',
        baseUrl: 'https://www.code-cli.cn/v1',
        credentialState: '缺失',
        modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      },
      deepseek: {
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        credentialState: '缺失',
        modelIds: ['deepseek-chat', 'deepseek-reasoner'],
      },
      kimi: {
        displayName: 'Kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        credentialState: '缺失',
        modelIds: ['k3', 'k3-256k'],
      },
      provider: {
        displayName: 'Kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        credentialState: '已自动发现',
        modelIds: ['k3'],
      },
    },
    providerPresets: [],
    models: {},
    requiredFields: [],
  };
}

function providerRecoveryConfiguration() {
  const current = configuration();
  const defaultModel = model(
    'provider',
    'k3',
    ['coding', 'planning', 'structured-output', 'tools'],
  );
  return {
    ...current,
    config: {
      ...current.config,
      providers: {
        provider: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/provider',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        'default-model': defaultModel,
      },
      agentClasses: Object.fromEntries(
        Object.entries(current.config.agentClasses).map(([ref, value]) => [
          ref,
          {
            ...value,
            modelPolicy: { mode: 'fixed', modelRef: 'default-model' },
          },
        ]),
      ),
    },
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
        'pi-research': agentClass(
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
