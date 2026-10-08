const status = document.getElementById('status');
const retry = document.getElementById('retry');
const upgrade = document.getElementById('upgrade');
function render(state) {
  status.textContent = state.message;
  retry.hidden = state.phase !== 'error';
  retry.disabled = state.phase === 'connecting';
  upgrade.hidden = state.phase !== 'upgrade';
  upgrade.disabled = state.phase === 'connecting';
}
window.metaworkShell.onState(render);
window.metaworkShell.state().then(render);
retry.addEventListener('click', () => {
  retry.disabled = true;
  window.metaworkShell.retry().catch(() => render({ phase: 'error', message: '连接失败，请稍后重试。' }));
});
upgrade.addEventListener('click', async () => {
  upgrade.disabled = true;
  try { await window.metaworkShell.upgrade(); }
  catch { render({ phase: 'upgrade', message: '后台更新未完成。已有配置和数据会保留，可重试更新。' }); }
});
