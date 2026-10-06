import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { initializePlatform } from './platform/services';

void initializePlatform().then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)).catch(() => {
  const root = document.getElementById('root')!;
  root.textContent = '桌面偏好未能恢复。请从 MetaWork 菜单重新连接后台。';
});
