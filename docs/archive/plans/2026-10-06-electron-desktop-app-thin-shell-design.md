# MetaWork Desktop App - Electron 薄壳架构设计（参考 Deepseek Harness）

- Status: Design (待实施)
- Plan date: 2026-10-06 (修订版)
- Scope: 参考 Deepseek Harness 官方架构，采用 Monorepo + Electron 薄壳方案，最小化改动现有代码
- Authority: 本设计遵循 ADR-0020 核心模块所有权和依赖方向，保持现有内部架构完全不变

## 一、Deepseek Harness 架构调研

### 1.1 官方架构分析

**仓库结构：**
```
deepseek-ai/deepseek-harness/
├── apps/
│   └── desktop/              # Desktop 应用
│       ├── electron/
│       │   ├── main.ts       # 主进程：启动 CLI 子进程
│       │   └── preload.ts    # 预加载脚本
│       ├── package.json
│       └── README.md
├── packages/                 # 共享核心包
│   ├── core/
│   ├── web-ui/
│   └── ...
├── docs/
└── package.json              # Monorepo 根配置
```

**核心设计理念（官方 README 原文）：**

> "The desktop application is an **Electron shell** around the complete dsh Web application. An Electron RunAsNode child starts the shared profile runner, and Electron immediately loads the packaged Web entry at `dsh-app://app/`."

**关键架构点：**

1. ✅ **Electron 是薄壳（Shell）**：不集成业务逻辑
2. ✅ **CLI 作为子进程运行**：使用 Node.js RunAsNode
3. ✅ **完全复用 Web UI**：通过自定义协议加载
4. ✅ **Monorepo 管理**：apps/ 和 packages/ 分离
5. ✅ **零逻辑重复**：Desktop/Web/CLI 共享核心代码

### 1.2 为什么 Deepseek 不采用全集成？

**官方选择薄壳的理由（推测 + 验证）：**

| 维度 | 全集成（Main Process） | 薄壳（子进程 CLI） |
|------|----------------------|-------------------|
| **代码复用** | 需要重构通信层 | 100% 复用现有 CLI |
| **开发成本** | 高（IPC 桥接、传输层抽象） | 低（启动器 + 窗口） |
| **风险** | 中等（影响核心架构） | 极低（独立模块） |
| **维护** | 需要同步两套代码 | 自动同步（共享） |
| **进程隔离** | 无（共享内存） | 有（CLI 崩溃不影响窗口） |
| **调试** | 复杂（混合 Electron/Node） | 简单（独立调试 CLI） |

**结论：薄壳架构是最优解。**

---

## 二、MetaWork Desktop 架构设计（基于 Deepseek 方案）

### 2.1 核心原则

**四个"不"：**
1. ❌ **不修改** `src/` 核心逻辑
2. ❌ **不重构** Gateway 通信层
3. ❌ **不集成** 后端到 Electron Main Process
4. ❌ **不重写** Web UI

**三个"是"：**
1. ✅ **是** CLI 的启动器和窗口管理器
2. ✅ **是** Web UI 的原生容器
3. ✅ **是** 系统集成的桥梁（托盘、通知）

### 2.2 架构图

#### 进程拓扑

```
┌─────────────────────────────────────────────────────────┐
│             MetaWork Desktop (Electron App)              │
├─────────────────────────────────────────────────────────┤
│  Main Process (启动器 + 窗口管理)                        │
│  ├─ 启动 CLI 子进程                                      │
│  ├─ 创建 BrowserWindow                                  │
│  ├─ 系统托盘                                            │
│  ├─ 全局快捷键                                          │
│  └─ 自动更新                                            │
├─────────────────────────────────────────────────────────┤
│  Renderer Process (加载 Web UI)                         │
│  └─ http://127.0.0.1:<动态端口>                         │
└─────────────────────────────────────────────────────────┘
              │ spawn (子进程)
              ▼
┌─────────────────────────────────────────────────────────┐
│      MetaWork CLI (独立 Node.js 进程)                    │
│  $ node cli/dist/index.js server start --port 3000      │
│  ├─ AccountRuntime                                      │
│  ├─ ClientGateway                                       │
│  ├─ ControlKernel                                       │
│  ├─ Execution                                           │
│  └─ HTTP Server (Express)                               │
└─────────────────────────────────────────────────────────┘
```

**关键点：**
- Electron 和 CLI 是**两个独立进程**
- 通过 **HTTP**（而非 IPC）通信
- CLI 完全不知道自己运行在 Electron 中
- Renderer 就是一个加载 Web UI 的浏览器

#### Monorepo 目录结构

```
metawork/                           # 现有仓库改造为 Monorepo
├── apps/
│   ├── cli/                        # 现有 src/ 迁移（可选，先不动）
│   │   ├── src/
│   │   │   ├── index.ts            # CLI 入口
│   │   │   ├── gateway/            # 或者软链接到 packages/core
│   │   │   └── ...
│   │   └── package.json
│   ├── web/                        # 现有 web/ 迁移（可选）
│   │   ├── src/
│   │   └── package.json
│   └── desktop/                    # 新增 Desktop 应用
│       ├── electron/
│       │   ├── main.ts             # Electron 主进程
│       │   ├── preload.ts          # 预加载脚本
│       │   └── assets/             # 图标、托盘图标
│       ├── package.json
│       ├── electron-builder.yml    # 打包配置
│       └── README.md
├── packages/                       # 共享包（可选，逐步重构）
│   ├── core/                       # src/ 核心代码
│   ├── web-ui/                     # web/ UI 组件
│   └── planner/                    # planner/ 集成
├── planner/AnyFusion-Pi/           # Planner（保持不变）
├── pnpm-workspace.yaml             # Monorepo 配置
├── package.json                    # 根 package.json
└── turbo.json                      # Turborepo 配置（可选）
```

**重要说明：**
- **渐进式迁移**：可以先只创建 `apps/desktop/`，不动现有代码
- **软链接策略**：`apps/cli/src -> ../../src`（保持兼容）
- **最终目标**：所有 apps 共享 `packages/core`

---

## 三、详细技术实现

### 3.1 Electron Main Process（启动器）

```typescript
// apps/desktop/electron/main.ts
import { app, BrowserWindow, Tray, Menu, globalShortcut, dialog } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import getPort from 'get-port';
import waitOn from 'wait-on';
import log from 'electron-log';

/**
 * MetaWork Desktop 启动器
 * 职责：
 * 1. 启动 MetaWork CLI 作为子进程
 * 2. 创建 Electron 窗口加载 Web UI
 * 3. 系统托盘、快捷键等原生集成
 * 4. 进程生命周期管理
 */
class MetaWorkDesktop {
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private cliProcess: ChildProcess | null = null;
  private serverPort: number | null = null;
  private dataRoot: string;

  constructor() {
    // 用户数据目录（与 CLI 共享）
    this.dataRoot = path.join(app.getPath('userData'), 'metawork-data');
    log.info('Data root:', this.dataRoot);
  }

  async start() {
    await app.whenReady();

    try {
      // 1. 获取随机可用端口
      this.serverPort = await getPort({ port: getPort.makeRange(3000, 3100) });
      log.info('Using port:', this.serverPort);

      // 2. 启动 CLI 子进程
      await this.startCLIProcess();

      // 3. 等待 Server 就绪
      await this.waitForServerReady();

      // 4. 创建主窗口
      this.createMainWindow();

      // 5. 系统集成
      this.createTray();
      this.registerGlobalShortcuts();
      this.setupAutoUpdater();

    } catch (error) {
      log.error('Failed to start MetaWork Desktop:', error);
      dialog.showErrorBox(
        'MetaWork 启动失败',
        `无法启动 MetaWork 服务：${(error as Error).message}`
      );
      app.quit();
    }
  }

  /**
   * 启动 MetaWork CLI 作为子进程
   */
  private async startCLIProcess(): Promise<void> {
    const isProduction = app.isPackaged;

    // CLI 可执行文件路径
    const cliPath = isProduction
      ? path.join(process.resourcesPath, 'app.asar.unpacked/cli/dist/index.js')
      : path.join(__dirname, '../../../dist/index.js'); // 开发模式

    log.info('Starting CLI from:', cliPath);

    // 启动子进程
    this.cliProcess = spawn(
      process.execPath, // 使用 Electron 自带的 Node.js
      [
        cliPath,
        'server',
        'start',
        '--port', String(this.serverPort),
        '--no-open', // 不自动打开浏览器
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          METAWORK_DATA_ROOT: this.dataRoot,
          METAWORK_CONFIG_HOME: path.join(this.dataRoot, 'config'),
          NODE_ENV: isProduction ? 'production' : 'development',
        },
        // RunAsNode 模式（类似 Deepseek Harness）
        detached: false,
      }
    );

    // 日志转发
    this.cliProcess.stdout?.on('data', (data) => {
      log.info('[CLI]', data.toString().trim());
    });

    this.cliProcess.stderr?.on('data', (data) => {
      log.error('[CLI]', data.toString().trim());
    });

    // 意外退出处理
    this.cliProcess.on('exit', (code) => {
      log.warn(`CLI process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        dialog.showErrorBox(
          'MetaWork 服务异常退出',
          `进程退出码: ${code}\n\n请查看日志了解详情。`
        );
        app.quit();
      }
    });

    log.info('CLI process started with PID:', this.cliProcess.pid);
  }

  /**
   * 等待 Server 启动完成
   */
  private async waitForServerReady(): Promise<void> {
    const url = `http://127.0.0.1:${this.serverPort}`;
    log.info('Waiting for server at:', url);

    try {
      await waitOn({
        resources: [url],
        timeout: 30000, // 30 秒超时
        interval: 500,
        log: false,
      });
      log.info('Server is ready');
    } catch (error) {
      throw new Error(`Server 启动超时: ${url}`);
    }
  }

  /**
   * 创建主窗口
   */
  private createMainWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      title: 'MetaWork',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      backgroundColor: '#1e1e1e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        // 允许加载本地 Server
        webSecurity: true,
      },
    });

    // 加载本地 Web UI
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;
    this.mainWindow.loadURL(serverUrl);

    // 开发模式打开 DevTools
    if (!app.isPackaged) {
      this.mainWindow.webContents.openDevTools();
    }

    // 窗口事件
    this.mainWindow.on('close', (event) => {
      if (!app.isQuitting && process.platform === 'darwin') {
        // macOS: 关闭窗口不退出应用
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    log.info('Main window created');
  }

  /**
   * 创建系统托盘
   */
  private createTray(): void {
    const iconPath = path.join(__dirname, '../assets/tray-icon.png');
    this.tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          this.mainWindow?.show();
          this.mainWindow?.focus();
        },
      },
      {
        label: '新建对话',
        click: () => {
          this.mainWindow?.show();
          this.mainWindow?.webContents.send('create-conversation');
        },
      },
      { type: 'separator' },
      {
        label: '打开数据目录',
        click: () => {
          const { shell } = require('electron');
          shell.openPath(this.dataRoot);
        },
      },
      {
        label: '查看日志',
        click: () => {
          const { shell } = require('electron');
          shell.openPath(log.transports.file.getFile().path);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip('MetaWork');

    // 双击托盘图标显示窗口
    this.tray.on('double-click', () => {
      this.mainWindow?.show();
      this.mainWindow?.focus();
    });

    log.info('Tray created');
  }

  /**
   * 注册全局快捷键
   */
  private registerGlobalShortcuts(): void {
    // Cmd/Ctrl + Shift + M: 显示/隐藏主窗口
    const ret = globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (this.mainWindow?.isVisible()) {
        this.mainWindow.hide();
      } else {
        this.mainWindow?.show();
        this.mainWindow?.focus();
      }
    });

    if (ret) {
      log.info('Global shortcut registered: CommandOrControl+Shift+M');
    } else {
      log.warn('Failed to register global shortcut');
    }
  }

  /**
   * 自动更新（占位）
   */
  private setupAutoUpdater(): void {
    // TODO: 集成 electron-updater
    log.info('Auto-updater setup (placeholder)');
  }

  /**
   * 优雅关闭
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down...');

    // 1. 注销全局快捷键
    globalShortcut.unregisterAll();

    // 2. 关闭 CLI 子进程
    if (this.cliProcess && !this.cliProcess.killed) {
      log.info('Terminating CLI process...');
      this.cliProcess.kill('SIGTERM');

      // 等待最多 3 秒
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.cliProcess && !this.cliProcess.killed) {
            log.warn('CLI process did not exit, forcing kill');
            this.cliProcess.kill('SIGKILL');
          }
          resolve();
        }, 3000);

        this.cliProcess?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    // 3. 退出应用
    app.quit();
  }
}

// ==================== 启动入口 ====================

const desktop = new MetaWorkDesktop();

app.on('ready', () => {
  desktop.start();
});

app.on('window-all-closed', () => {
  // Windows/Linux: 所有窗口关闭后退出
  if (process.platform !== 'darwin') {
    desktop.shutdown();
  }
});

app.on('activate', () => {
  // macOS: 点击 Dock 图标重新显示窗口
  if (BrowserWindow.getAllWindows().length === 0) {
    desktop.start();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

// 处理未捕获异常
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  dialog.showErrorBox('发生错误', error.message);
});
```

### 3.2 Preload Script（安全桥接）

```typescript
// apps/desktop/electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

/**
 * 暴露安全的 API 到 Renderer
 * 注意：不需要暴露 MetaWork 业务 API，因为 Renderer 直接通过 HTTP 与 CLI 通信
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,

  // 监听主进程事件
  onCreateConversation: (callback: () => void) => {
    ipcRenderer.on('create-conversation', callback);
  },

  // 打开外部链接
  openExternal: (url: string) => {
    ipcRenderer.invoke('open-external', url);
  },

  // 显示保存对话框
  showSaveDialog: (options: any) => {
    return ipcRenderer.invoke('show-save-dialog', options);
  },

  // 获取应用版本
  getVersion: () => {
    return ipcRenderer.invoke('get-version');
  },
});

// TypeScript 类型声明
declare global {
  interface Window {
    electronAPI: {
      platform: string;
      onCreateConversation: (callback: () => void) => void;
      openExternal: (url: string) => Promise<void>;
      showSaveDialog: (options: any) => Promise<any>;
      getVersion: () => Promise<string>;
    };
  }
}
```

### 3.3 Package.json 配置

```json
// apps/desktop/package.json
{
  "name": "@metawork/desktop",
  "version": "1.0.0",
  "description": "MetaWork Desktop Application",
  "main": "dist/electron/main.js",
  "author": "IFOSR",
  "license": "Proprietary",
  "scripts": {
    "dev": "concurrently \"npm run dev:cli\" \"npm run dev:electron\"",
    "dev:cli": "cd ../.. && npm run dev",
    "dev:electron": "wait-on http://127.0.0.1:3000 && electron .",
    "build": "tsc && copyfiles electron/assets/** dist/",
    "package": "npm run build && electron-builder",
    "package:mac": "npm run package -- --mac",
    "package:win": "npm run package -- --win",
    "package:linux": "npm run package -- --linux",
    "package:all": "npm run package -- --mac --win --linux"
  },
  "dependencies": {
    "electron-log": "^5.0.3",
    "get-port": "^7.0.0",
    "wait-on": "^7.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "concurrently": "^8.2.2",
    "copyfiles": "^2.4.1",
    "electron": "^28.2.0",
    "electron-builder": "^24.9.1",
    "typescript": "^5.3.0"
  }
}
```

### 3.4 Electron Builder 配置

```yaml
# apps/desktop/electron-builder.yml
appId: com.ifosr.metawork
productName: MetaWork
copyright: Copyright © 2026 IFOSR

directories:
  output: ../../dist-electron
  buildResources: electron/assets

files:
  - dist/electron/**/*
  - package.json
  # 打包完整的 CLI
  - from: ../../dist/
    to: cli/dist/
  # 打包 node_modules（CLI 依赖）
  - from: ../../node_modules/
    to: cli/node_modules/
    filter:
      - "**/*"
      - "!**/*.{md,ts,map}"
      - "!**/test/**"
      - "!**/tests/**"
  # 打包 Planner
  - from: ../../planner/AnyFusion-Pi/
    to: cli/planner/AnyFusion-Pi/
    filter:
      - "**/*"
      - "!.git/**"

asar: true
asarUnpack:
  - "cli/dist/**"
  - "cli/node_modules/better-sqlite3/**"
  - "cli/planner/AnyFusion-Pi/bin/**"
  - "cli/planner/AnyFusion-Pi/node_modules/**"

mac:
  category: public.app-category.developer-tools
  icon: electron/assets/icon.icns
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: electron/build/entitlements.mac.plist
  entitlementsInherit: electron/build/entitlements.mac.plist

dmg:
  title: ${productName} ${version}
  icon: electron/assets/icon.icns
  background: electron/assets/dmg-background.png
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications

win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  icon: electron/assets/icon.ico

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: always
  createStartMenuShortcut: true
  perMachine: false

linux:
  target:
    - target: AppImage
      arch: [x64]
    - target: deb
      arch: [x64]
    - target: rpm
      arch: [x64]
  icon: electron/assets/icon.png
  category: Development

publish:
  provider: generic
  url: https://14.103.216.193/metawork-releases/desktop/
```

### 3.5 Monorepo 配置

```yaml
# pnpm-workspace.yaml（仓库根目录）
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// package.json（仓库根目录）
{
  "name": "metawork-monorepo",
  "private": true,
  "version": "1.0.0",
  "description": "MetaWork Monorepo",
  "scripts": {
    "dev": "npm run dev --workspace=@metawork/desktop",
    "build": "npm run build --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  },
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "devDependencies": {
    "turbo": "^1.11.0"
  },
  "engines": {
    "node": ">=22.19.0",
    "pnpm": ">=8.0.0"
  }
}
```

```json
// turbo.json（可选，加速构建）
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "outputs": []
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

---

## 四、开发与调试

### 4.1 本地开发

```bash
# 1. 安装依赖（根目录，首次）
pnpm install

# 2. 启动开发模式
cd apps/desktop
pnpm run dev

# 这会自动：
# - 启动 CLI Server (http://127.0.0.1:3000)
# - 启动 Electron 窗口加载 Web UI
```

### 4.2 调试 CLI 子进程

```bash
# 单独启动 CLI（不启动 Electron）
cd metawork
npm run dev

# 在浏览器访问
open http://127.0.0.1:3000
```

### 4.3 调试 Electron

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Electron: Main",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}/apps/desktop",
      "runtimeExecutable": "${workspaceFolder}/apps/desktop/node_modules/.bin/electron",
      "args": ["."],
      "outputCapture": "std"
    }
  ]
}
```

### 4.4 热更新支持

**CLI 热更新：**
- 使用 `nodemon` 或 `tsx watch`
- 修改 `src/` 代码自动重启

**Web UI 热更新：**
- Vite HMR 自动生效
- 修改 `web/src/` 代码浏览器自动刷新

**Electron 热更新：**
- 使用 `electron-reloader`（可选）
- 修改 `apps/desktop/electron/` 代码需要重启

---

## 五、打包与分发

### 5.1 打包流程

```bash
# 1. 构建 CLI（根目录）
cd metawork
npm run build

# 2. 构建 Desktop
cd apps/desktop
npm run build

# 3. 打包当前平台
npm run package

# 4. 打包所有平台（需要对应环境）
npm run package:all
```

### 5.2 产物结构

```
dist-electron/
├── MetaWork-1.0.0-mac-x64.dmg          # macOS Intel
├── MetaWork-1.0.0-mac-arm64.dmg        # macOS Apple Silicon
├── MetaWork-1.0.0-win-x64.exe          # Windows 安装器
├── MetaWork-1.0.0-win-x64-portable.exe # Windows 绿色版
├── MetaWork-1.0.0-linux-x64.AppImage   # Linux 单文件
├── MetaWork-1.0.0-linux-x64.deb        # Debian/Ubuntu
└── MetaWork-1.0.0-linux-x64.rpm        # RedHat/Fedora
```

### 5.3 体积估算

| 组件 | 大小 | 说明 |
|------|------|------|
| Electron Runtime | ~120MB | Chromium + Node.js |
| MetaWork CLI | ~50MB | dist/ + node_modules |
| Planner | ~30MB | AnyFusion-Pi |
| Web UI | ~5MB | 编译后 |
| **总计（压缩前）** | **~205MB** | |
| **DMG/Installer（压缩后）** | **~150MB** | |

**优化策略：**
- 移除 `node_modules` 中的 devDependencies
- 使用 `asar` 压缩
- Tree-shaking 移除未使用代码
- 目标：macOS < 130MB，Windows < 100MB

---

## 六、实施路线图

### Phase 1: Monorepo 基础搭建（3 天）

**目标：**建立 Monorepo 结构，不影响现有开发

**任务：**
- [ ] 创建 `pnpm-workspace.yaml`
- [ ] 创建 `apps/desktop/` 目录结构
- [ ] 配置 `turbo.json`（可选）
- [ ] 验证：`pnpm install` 成功

**验收标准：**
- 现有 `npm run dev` 仍然正常工作
- `apps/desktop/` 有基础文件
- pnpm workspace 识别所有包

---

### Phase 2: Electron 启动器实现（3 天）

**目标：**Electron 能够启动 CLI 并加载 Web UI

**任务：**
- [ ] 实现 `main.ts`（启动 CLI 子进程）
- [ ] 实现端口检测和等待逻辑
- [ ] 实现基础窗口管理
- [ ] 配置 `electron-builder.yml`
- [ ] 验证：`pnpm run dev` 启动 Desktop

**验收标准：**
- 双击后 Electron 窗口显示 Web UI
- 可以正常创建对话、执行任务
- 日志正常输出到 electron-log

---

### Phase 3: 系统集成（3 天）

**目标：**实现桌面应用特有的原生功能

**任务：**
- [ ] 系统托盘（最小化到托盘）
- [ ] 全局快捷键（Cmd/Ctrl+Shift+M）
- [ ] 原生通知（任务完成时）
- [ ] 应用菜单（macOS 顶部菜单）
- [ ] 窗口状态持久化（位置、大小）

**验收标准：**
- 关闭窗口后托盘仍然运行
- 快捷键可以唤起/隐藏窗口
- macOS 顶部菜单完整
- 重新打开后窗口位置不变

---

### Phase 4: 打包与测试（4 天）

**目标：**生成可分发的安装包

**任务：**
- [ ] 配置 macOS 代码签名
- [ ] 配置 Windows 代码签名（可选）
- [ ] 测试打包流程（三平台）
- [ ] 编写打包文档
- [ ] 测试安装包（干净系统）

**验收标准：**
- macOS DMG 可以正常安装和启动
- Windows NSIS 可以正常安装和卸载
- Linux AppImage 可以直接运行
- 没有权限警告（macOS Gatekeeper）

---

### Phase 5: 自动更新与发布（3 天）

**目标：**实现自动更新机制

**任务：**
- [ ] 集成 `electron-updater`
- [ ] 配置更新服务器（复用 14.103.216.193）
- [ ] 实现更新检查和下载
- [ ] 实现更新 UI（可选）
- [ ] 编写发布流程文档

**验收标准：**
- 应用启动时检查更新
- 有新版本时提示用户
- 可以一键下载并安装更新
- 更新失败不影响当前版本

---

### Phase 6: 文档与优化（2 天）

**目标：**完善用户文档和性能优化

**任务：**
- [ ] 编写用户手册
- [ ] 编写常见问题 FAQ
- [ ] 启动性能优化（< 3 秒）
- [ ] 内存占用优化（< 300MB 空闲）
- [ ] 错误提示优化

**验收标准：**
- 有完整的安装、使用、故障排查文档
- 冷启动 < 3 秒
- 长时间运行无明显内存泄漏

---

**总计：18 天（约 3.5 周）**

---

## 七、风险与缓解

### 7.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **CLI 子进程启动失败** | 应用无法使用 | 中 | 1. 完善错误处理和日志<br>2. 提供手动启动 CLI 的降级方案<br>3. 端口冲突自动重试 |
| **跨平台兼容性问题** | 某些平台不可用 | 中 | 1. 三平台自动化测试<br>2. Beta 测试覆盖所有平台<br>3. 平台特定代码隔离 |
| **Planner 子进程通信异常** | 对话功能失败 | 低 | 1. 复用现有稳定的 CLI 逻辑<br>2. 完善重试机制 |
| **打包体积过大** | 下载慢，占用存储 | 低 | 1. 优化依赖，移除 dev 包<br>2. asar 压缩<br>3. 提供在线安装器 |

### 7.2 产品风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **用户习惯改变** | 现有用户不适应 | 低 | 1. Desktop 是可选的，不强制<br>2. CLI/TUI/Web 继续维护<br>3. 提供迁移指南 |
| **维护成本增加** | 三种模式并存 | 中 | 1. Desktop 共享所有逻辑<br>2. 仅增加启动器代码<br>3. CI 自动化测试 |

### 7.3 架构风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **Monorepo 迁移复杂** | 影响现有开发 | 低 | 1. 渐进式迁移，先不动现有代码<br>2. 软链接保持兼容<br>3. 独立测试 Desktop |
| **子进程管理复杂** | 进程泄漏、僵尸进程 | 中 | 1. 完善生命周期管理<br>2. 超时保护<br>3. 优雅退出和强制清理 |

---

## 八、与现有架构的关系

### 8.1 完全兼容

```
保持 100% 不变的模块：
├── src/                 ✅ 所有业务逻辑不变
│   ├── gateway/         ✅ 通信层不变
│   ├── kernel/          ✅ 控制内核不变
│   ├── execution/       ✅ 执行后端不变
│   ├── work-graph/      ✅ 工作图不变
│   └── ...
├── planner/             ✅ Planner 不变
├── web/                 ✅ Web UI 不变
└── package.json         ✅ CLI 依赖不变

新增的模块：
└── apps/desktop/        ➕ 独立的启动器
    └── electron/
```

### 8.2 数据共享

**完全兼容的数据目录：**
```
~/.metawork/                        # 或 app.getPath('userData')
├── accounts/
│   └── local-default/
│       ├── tasks.db                # CLI 和 Desktop 共享
│       ├── config.json             # 共享配置
│       └── secrets.json            # 共享凭证
└── planner-sessions/               # 共享 Planner 会话
```

**切换模式：**
```bash
# 今天用 CLI
metawork tui

# 明天用 Desktop
open /Applications/MetaWork.app

# 数据完全互通，无需迁移
```

### 8.3 三种模式对比

| 特性 | CLI/TUI | Web | Desktop |
|------|---------|-----|---------|
| **安装** | npm/脚本 | 无需安装 | DMG/EXE |
| **启动** | 命令行 | 浏览器 | 双击图标 |
| **托盘** | ❌ | ❌ | ✅ |
| **快捷键** | ❌ | ❌ | ✅ |
| **通知** | ❌ | 网页通知 | 系统通知 |
| **更新** | npm update | 刷新页面 | 自动更新 |
| **目标用户** | 开发者 | 所有人 | 普通用户 |

---

## 九、成功指标

### 9.1 用户体验

- ✅ 安装时长：< 5 分钟（下载 + 安装 + 首次启动）
- ✅ 启动速度：冷启动 < 3 秒
- ✅ 零命令行：100% 功能通过 GUI 完成
- ✅ 新用户成功率：> 95%（首次启动成功）

### 9.2 技术指标

- ✅ 包体积：macOS < 150MB，Windows < 120MB
- ✅ 内存占用：空闲 < 300MB，工作 < 600MB
- ✅ 崩溃率：< 0.1%（每千次启动）
- ✅ 平台覆盖：macOS 10.13+, Windows 10+, Ubuntu 18.04+

### 9.3 开发效率

- ✅ 代码复用：> 99%（仅新增 ~500 行启动器代码）
- ✅ 构建时间：< 5 分钟（包含三平台）
- ✅ 回归风险：0（不修改现有代码）

---

## 十、FAQ

### Q1: 为什么不直接集成后端到 Electron Main Process？

**A:** 参考 Deepseek Harness 官方架构，子进程方案有明显优势：
1. **零重构成本**：CLI 代码完全不变
2. **进程隔离**：CLI 崩溃不影响窗口
3. **易于调试**：可以单独调试 CLI 和 Electron
4. **维护简单**：Desktop 只是启动器，不需要同步业务逻辑

### Q2: Monorepo 会不会影响现有开发？

**A:** 不会，采用渐进式迁移：
1. 现有代码暂时不移动，通过软链接兼容
2. 现有 `npm run dev` 等命令完全不变
3. Desktop 作为独立 workspace，不依赖其他包
4. 未来可选择性重构为 `packages/core`

### Q3: 为什么使用 pnpm 而不是 npm？

**A:** pnpm 是现代 Monorepo 最佳实践：
1. 更快的安装速度（硬链接）
2. 更节省磁盘空间（全局 store）
3. 更严格的依赖管理（防止幽灵依赖）
4. workspace 支持更好

但可以兼容 npm：只需将 `pnpm-workspace.yaml` 改为 `package.json` 的 `workspaces` 字段。

### Q4: 如何确保 CLI 子进程正确退出？

**A:** 实现了多层保护：
1. 监听 Electron 退出事件，发送 SIGTERM
2. 3 秒超时后发送 SIGKILL 强制终止
3. 记录 PID，防止僵尸进程
4. 开发模式下可以手动清理

### Q5: Desktop 和 Web 的 UI 会不会不一致？

**A:** 完全一致，因为：
1. Desktop 的 Renderer 就是加载 Web UI
2. 使用同一套 React 组件
3. 使用同一套 API（HTTP）
4. 唯一区别是可以调用 `window.electronAPI`（可选）

---

## 十一、下一步行动

### 立即行动（本周）

1. ✅ **评审本文档**：团队确认技术方案
2. ⬜ **安装 pnpm**：`npm install -g pnpm`
3. ⬜ **创建 Monorepo 结构**：`pnpm-workspace.yaml`
4. ⬜ **实现 Phase 1**：基础目录结构

### 决策点

- [ ] 批准本设计文档（参考 Deepseek Harness 架构）
- [ ] 确认 Phase 1 开始时间
- [ ] 分配开发资源（1 人全职 3.5 周）
- [ ] 确定 Beta 测试用户

---

## 十二、参考资料

### 内部文档
- [ADR-0020: Core Module Ownership](../adr/0020-core-module-ownership-and-dependency-direction.md)
- [ADR-0031: Account Runtime](../adr/0031-account-runtime-and-unified-client-gateway.md)
- [Technical Overview](technical-overview.md)
- [One-Command Install](2026-09-03-phase2-one-command-install.md)

### 外部参考
- [Deepseek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)（架构灵感来源）
- [Electron 官方文档](https://www.electronjs.org/docs/latest/)
- [electron-builder 文档](https://www.electron.build/)
- [pnpm Workspace 文档](https://pnpm.io/workspaces)
- [Turborepo 文档](https://turbo.build/repo/docs)（可选）

### 类似项目参考
- **VSCode**：Electron + Monorepo（lerna）
- **Cursor**：VSCode fork + Electron
- **Warp**：Rust + WebView（不同技术栈但相似架构）
- **Zed**：独立进程 + IPC（参考进程隔离设计）

---

**文档状态：** 等待评审（修订版）\
**负责人：** TBD\
**预计完成时间：** 3.5 周（18 天）\
**关键改进：** 采用 Deepseek Harness 官方架构，降低风险和成本
