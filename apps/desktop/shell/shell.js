const status = document.getElementById('status');
const retry = document.getElementById('retry');
const setup = document.getElementById('setup');
let settingUp = false;
function render(state) {
  status.textContent = state.message;
  retry.hidden = state.phase !== 'error';
  retry.disabled = state.phase === 'connecting';
  setup.hidden = state.phase !== 'setup' && !settingUp;
  for (const field of setup.elements) field.disabled = state.phase === 'connecting';
}
window.metaworkShell.onState(render);
window.metaworkShell.state().then(render);
retry.addEventListener('click', () => {
  retry.disabled = true;
  window.metaworkShell.retry().catch(() => render({ phase: 'error', message: '连接失败，请稍后重试。' }));
});
setup.addEventListener('submit', async event => {
  event.preventDefault();
  settingUp = true;
  try {
    await window.metaworkShell.setup({ baseUrl: document.getElementById('provider-url').value,
      modelId: document.getElementById('model-id').value, apiKey: document.getElementById('api-key').value });
  } catch { render({ phase: 'setup', message: '请检查模型地址、模型 ID 和 API Key 后重试。' }); }
  finally { settingUp = false; }
});
