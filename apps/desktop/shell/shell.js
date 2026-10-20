const status = document.getElementById('status');
const heading = document.getElementById('heading');
const retry = document.getElementById('retry');
const quit = document.getElementById('quit');
const upgrade = document.getElementById('upgrade');
const updateStatus = document.getElementById('update-status');
const updateProgress = document.getElementById('update-progress');
function render(state) {
  const retryable = state.retryable !== false && state.action !== 'quit';
  heading.textContent = state.action === 'quit' ? '需要更新桌面应用'
    : state.phase === 'upgrade' ? '准备完成更新'
    : state.phase === 'error' ? '后台服务暂时不可用' : '让工作继续';
  status.textContent = state.message;
  const busy = state.busy === true;
  updateStatus.hidden = !busy;
  updateStatus.setAttribute('aria-busy', String(busy));
  if (state.progress == null) updateProgress.removeAttribute('style');
  else updateProgress.style.width = `${Math.max(0, Math.min(100, state.progress))}%`;
  retry.hidden = state.phase !== 'error' || !retryable;
  retry.disabled = state.phase === 'connecting' || busy;
  quit.hidden = state.phase !== 'error' || retryable;
  quit.disabled = state.phase === 'connecting' || busy;
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
quit.addEventListener('click', () => {
  quit.disabled = true;
  window.metaworkShell.quit().catch(() => {
    quit.disabled = false;
    render({ phase: 'error', retryable: false, action: 'quit', message: '应用暂时无法退出，请使用菜单中的“退出 MetaWork”。' });
  });
});
upgrade.addEventListener('click', async () => {
  upgrade.disabled = true;
  try { await window.metaworkShell.upgrade(); }
  catch { render({ phase: 'upgrade', message: '后台更新未完成。已有配置和数据会保留，可重试更新。' }); }
});
