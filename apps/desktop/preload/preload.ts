import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopMenuAction, DesktopShellBridge, ShellState } from '../shared/bridge.js';

// Main independently authorizes every call; preload availability is not an authorization decision.
if (process.isMainFrame) {
  if (location.protocol === 'file:') {
    const bridge: DesktopShellBridge = {
      state: () => ipcRenderer.invoke('shell:state'),
      retry: () => ipcRenderer.invoke('shell:retry'),
      upgrade: () => ipcRenderer.invoke('shell:upgrade'),
      onState: listener => {
        const receive = (_event: unknown, state: ShellState) => listener(state);
        ipcRenderer.on('shell:state', receive);
        return () => { ipcRenderer.removeListener('shell:state', receive); };
      },
    };
    contextBridge.exposeInMainWorld('metaworkShell', Object.freeze(bridge));
  } else if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
    const bridge: DesktopBridge = {
      version: 1,
      selectWorkspaceDirectory: () => ipcRenderer.invoke('desktop:select-workspace'),
      selectExecutorFile: () => ipcRenderer.invoke('desktop:select-executor'),
      repairPi: () => ipcRenderer.invoke('desktop:repair-pi'),
      saveArtifact: id => ipcRenderer.invoke('desktop:save-artifact', id),
      showDownloadedArtifact: id => ipcRenderer.invoke('desktop:reveal-artifact', id),
      readPreferences: () => ipcRenderer.invoke('desktop:preferences'),
      setTheme: theme => ipcRenderer.invoke('desktop:theme', theme),
      setDraft: (id, draft) => ipcRenderer.invoke('desktop:draft', id, draft),
      clearDrafts: () => ipcRenderer.invoke('desktop:clear-drafts'),
      setViewport: (id, value) => ipcRenderer.invoke('desktop:viewport', id, value),
      setRoute: route => ipcRenderer.invoke('desktop:route', route),
      reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
      onMenu: listener => {
        const receive = (_event: unknown, action: DesktopMenuAction) => listener(action);
        ipcRenderer.on('desktop:menu', receive);
        return () => { ipcRenderer.removeListener('desktop:menu', receive); };
      },
    };
    contextBridge.exposeInMainWorld('metaworkDesktop', Object.freeze(bridge));
  }
}
