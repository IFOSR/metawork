import assert from 'node:assert/strict';

/** Exercise AppKit menu state through the real Electron main process. */
export async function verifyDesktopMenu(app) {
  const menu = await app.evaluate(({ Menu }) => {
    const root = Menu.getApplicationMenu();
    return { reconnect: root.getMenuItemById('reconnect').enabled,
      repair: root.getMenuItemById('repair-update').visible,
      labels: root.items[0].submenu.items.filter(item => item.visible).map(item => item.label) };
  });
  assert.equal(menu.reconnect, false);
  assert.equal(menu.repair, false);
  assert(menu.labels.includes('高级') || menu.labels.includes('Advanced'));
  assert(!menu.labels.some(label => /终端|Terminal|清除|Clear|数据目录/.test(label)));
  // Break only the disposable client's notification transport, then restore it.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://127.0.0.1:*/api/client/notifications*'] }, (_, callback) => callback({ cancel: true }));
  });
  const waitMenu = async enabled => {
    const deadline = Date.now() + 15000;
    while (await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('reconnect').enabled) !== enabled) {
      assert(Date.now() < deadline, 'Reconnect state did not follow backend availability');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  try {
    await waitMenu(true);
    assert.equal(await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().getMenuItemById('reconnect');
      item.click();
      return item.enabled;
    }), false);
  }
  finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest(null));
  }
  await waitMenu(false);
  const messages = await app.evaluate(async ({ Menu, dialog }) => {
    const originalFetch = globalThis.fetch;
    const originalDialog = dialog.showMessageBox;
    const messages = [];
    try {
      dialog.showMessageBox = async (_window, options) => { messages.push(options.message); return { response: 0 }; };
      globalThis.fetch = async () => Response.json({ tag_name: 'v0.1.7', assets: [] });
      Menu.getApplicationMenu().getMenuItemById('check-update').click();
      const deadline = Date.now() + 5000;
      while (!messages.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      return messages;
    } finally { globalThis.fetch = originalFetch; dialog.showMessageBox = originalDialog; }
  });
  assert.deepEqual(messages, ['暂无更新版本']);
  console.log('Desktop menu: connected/connecting disabled, disconnect/recovery, advanced grouping and update check passed.');
}
