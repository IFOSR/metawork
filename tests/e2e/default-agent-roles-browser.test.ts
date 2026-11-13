import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { buildSourceInstallConfiguration } from '../../src/installation/source-native-installer.js';
import { projectExecutorManagement } from '../../src/configuration/executor-configuration.js';
import { validateConfigurationCandidate } from '../../src/configuration/configuration-validator.js';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

describe.runIf(process.env.RUN_BROWSER_E2E === '1')('default roles onboarding on 8788', () => {
  it('requires explicit model selection, enables all three on save and retains the choices on reopen', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    let snapshot = { revisionId: 'role-initial', contentHash: 'fixture', config: buildSourceInstallConfiguration({ releaseId: 'test', sourceRoot: '/fixture/source' }) };
    const bundle = await build({ stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { SettingsPanel } from './src/components/SettingsPanel';
      const request = async (path, body) => {
        const response = await fetch('/__default_roles__/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
        return response.json();
      };
      const http = {
        getConfig: () => request('config'),
        getConfigurationCompletion: async () => ({ providers: {}, models: {}, providerPresets: [], requiredFields: [] }),
        getActivationStatus: async () => ({ activationAllowed: true, activationStatus: 'idle' }),
        getSpanCredentialStatus: async () => ({ configured: false }),
        getSecretStatus: async () => ({ provider: { configured: true, maskedApiKey: 'configured' } }),
        getExecutorManagement: () => request('executors'),
        requestMemory: async () => ({ mode: 'disabled', selectableProviders: [] }),
        describeAgentCapabilities: async () => ({ summary: '测试模型能力', abilities: [], boundaries: [] }),
        activate: (baseRevisionId, config) => request('activate', { baseRevisionId, config }),
      };
      const root = createRoot(document.getElementById('root'));
      let version = 0;
      window.reopen = () => root.render(<SettingsPanel key={version++} http={http} runtime={null} onClose={() => {}} />);
      window.reopen();
    ` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let activated = false;
    await page.route('http://127.0.0.1:8788/__default_roles__/**', async route => {
      const path = new URL(route.request().url()).pathname.split('/').at(-1);
      const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (path === 'config') return json(snapshot);
      if (path === 'executors') return json(projectExecutorManagement(snapshot));
      if (path === 'activate') {
        const body = route.request().postDataJSON();
        const result = validateConfigurationCandidate(body.config);
        if (!result.ok) return json({ ok: false, code: 'invalid_configuration', issues: result.issues.map(issue => issue.message) });
        expect(body.baseRevisionId).toBe(snapshot.revisionId);
        snapshot = { ...snapshot, config: result.config, revisionId: 'role-activated' };
        activated = true;
        return json({ ok: true, revisionId: snapshot.revisionId });
      }
      return route.fulfill({ contentType: path === 'fixture.js' ? 'text/javascript' : path === 'styles.css' ? 'text/css' : 'text/html',
        body: path === 'fixture.js' ? bundle.outputFiles[0]!.text : path === 'styles.css' ? styles
          : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>' });
    });
    try {
      await page.goto('http://127.0.0.1:8788/__default_roles__/');
      await page.getByRole('button', { name: '为总管绑定模型', exact: true }).waitFor();
      expect(await page.locator('.agent-summary-row').count()).toBe(3);
      expect(await page.getByText('全部智能体已停用，请先启用至少一名智能体。', { exact: true }).count()).toBe(0);
      expect(await page.locator('.agent-summary-row .state-badge').allTextContents()).toEqual(Array(3).fill('默认启用 · 待绑定模型'));
      expect(await page.getByRole('button', { name: '保存并激活', exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: '为总管绑定模型', exact: true }).click();
      expect(await page.getByRole('checkbox', { name: '启用规划智能体' }).count()).toBe(0);
      expect(await page.getByLabel('总管的模型').inputValue()).toBe('');
      expect(await page.locator('.route-invalid').innerText()).toContain('请先在“模型服务”添加');
      await page.getByRole('button', { name: '为助理绑定模型', exact: true }).click();
      const assistant = page.locator('.routing-stack > div').filter({ has: page.locator('.agent-summary-title strong', { hasText: '助理' }) });
      await assistant.getByRole('button', { name: '停用', exact: true }).click();
      expect(await assistant.locator('.state-badge').innerText()).toBe('已停用');
      await assistant.getByRole('button', { name: '启用', exact: true }).click();
      expect(await assistant.locator('.state-badge').innerText()).toBe('默认启用 · 待绑定模型');

      // A configured user model becomes available; the roles must not bind to it automatically.
      const supplied = buildSourceInstallConfiguration({ releaseId: 'test', sourceRoot: '/fixture/source', provider: {
        baseUrl: 'https://example.test/v1', apiKey: 'fixture', modelId: 'user-model', region: 'international', secretReference: 'file-secret:fixture/model',
      } });
      snapshot.config.providers = supplied.providers;
      snapshot.config.models = { 'user-model': supplied.models['default-model'] };
      await page.evaluate(() => (window as any).reopen());
      await page.getByRole('button', { name: '为总管绑定模型', exact: true }).waitFor();
      for (const name of ['总管', '助理', '分析师']) {
        await page.getByRole('button', { name: `为${name}绑定模型`, exact: true }).click();
        expect(await page.getByLabel(`${name}的模型`).inputValue()).toBe('');
        await page.getByLabel(`${name}的模型`).selectOption('user-model');
      }
      const save = page.getByRole('button', { name: '保存并激活', exact: true });
      expect(await save.isEnabled()).toBe(true);
      await save.click();
      await page.getByText('配置已热激活。新任务和下一轮 Manager 将使用新配置。', { exact: true }).waitFor();
      expect(activated).toBe(true);
      expect(Object.values(snapshot.config.agentClasses).every(agent => agent.enabled && agent.modelPolicy.mode === 'fixed' && agent.modelPolicy.modelRef === 'user-model')).toBe(true);
      await page.evaluate(() => (window as any).reopen());
      await page.locator('.agent-summary-row').first().waitFor();
      expect(await page.locator('.agent-summary-row .state-badge').allTextContents()).toEqual(['始终启用', '已启用', '已启用']);
      expect(await page.locator('.agent-summary-model').allTextContents()).toEqual(Array(3).fill('user-model'));
      // A role deliberately saved disabled must not resurrect as a default.
      snapshot.config.agentClasses['pi-research'].enabled = false;
      snapshot.config.agentClasses['pi-research'].modelPolicy = { mode: 'fixed', modelRef: 'default-model' };
      await page.evaluate(() => (window as any).reopen());
      await page.locator('.agent-summary-row').first().waitFor();
      const analyst = page.locator('.agent-summary-row').filter({ hasText: '分析师' });
      expect(await analyst.locator('.state-badge').innerText()).toBe('已停用');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});
