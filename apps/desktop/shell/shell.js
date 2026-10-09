const status = document.getElementById('status');
const retry = document.getElementById('retry');
const upgrade = document.getElementById('upgrade');
const updateStatus = document.getElementById('update-status');
const updateProgress = document.getElementById('update-progress');
function render(state) {
  status.textContent = state.message;
  const busy = state.busy === true;
  updateStatus.hidden = !busy;
  updateStatus.setAttribute('aria-busy', String(busy));
  if (state.progress == null) updateProgress.removeAttribute('style');
  else updateProgress.style.width = `${Math.max(0, Math.min(100, state.progress))}%`;
  retry.hidden = state.phase !== 'error';
  retry.disabled = state.phase === 'connecting' || busy;
  upgrade.hidden = state.phase !== 'upgrade';
  upgrade.disabled = state.phase === 'connecting' || busy;
  document.body.dataset.busy = String(busy);
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
