# MetaWork Windows 原生安装器修复方案（完整版）

> 最终目标（验收标准）：
> 1. 用户执行 **一条命令**（`.\metawork-install.ps1`）即完成安装；
> 2. 安装后用户直接执行 **`metawork server start`** 即启动成功（输出 `MetaWork Server ready`）。
>
> 全程不需要管理员权限、不需要开发者模式、不需要手动 `npm install`、不需要任何运行时补丁。

---

## 1. 背景：Windows 上失败发生在两个阶段

修复必须同时覆盖两个阶段，**缺一不可**。之前的调试正是漏了阶段二（运行阶段）。

### 阶段一：安装阶段失败

MetaWork 的 `install-cli.js` 及其依赖模块按 Linux/macOS 语义编写，在 Windows 上两类系统性不兼容：

| 问题 | POSIX 写法 | Windows 结果 |
|---|---|---|
| 目录/只读句柄 fsync | `openSync(dir,'r')` + `fsyncSync()`；`open(file,'r')` + `.sync()` | `openSync(目录)` 抛 `EISDIR`；只读句柄 fsync 抛 `EPERM` |
| 符号链接切换版本 | `fs.symlink(target, path[, 'dir'])` | 普通用户无 `SeCreateSymbolicLinkPrivilege`，抛 `EPERM` |
| chmod 只读语义 | `chmod(path, 0o444/0o555)` | Windows 上仅切换"只读属性"，与 POSIX 语义不等价 |
| 错误被吞 | `ServerUpdateCoordinator` 捕获后只返回 `aborted` | 用户只看到 `native install transaction aborted` |

### 阶段二：运行阶段失败（最容易被遗漏）

用 **junction** 替代符号链接后（junction 是 Windows 普通用户唯一可建的"目录链接"），有一个关键差异：

> **符号链接保存的是相对路径；junction 保存的是绝对路径。**

而运行时代码会 `readlink()` 这些指针，并按**相对路径**解析。于是：

```
启动失败: RecoveryBlockedError: active configuration pointer escapes revision storage
    at FileConfigurationRepository.readActiveRevisionId (...)
```

具体链路：`config/active` 是 junction，`readlink()` 返回绝对路径 `C:\...\config\revisions\<id>`，而 `readActiveRevisionId()` 要求它必须以 `revisions/` 开头 → 判定"逃逸" → 启动失败。

**结论**：只把 `symlink` 换成 junction 是不够的，必须同步把**所有 `readlink` 消费方**改成"归一化"读取，把 junction 的绝对目标转回相对路径。

### 附带问题：better-sqlite3 ABI 不匹配

| 问题 | 原因 |
|---|---|
| `better_sqlite3.node` ABI 不匹配 | 发布包用 Node 22 构建，只带 ABI 127 二进制；用户 Node 24 需要 ABI 137，且 11.10.0 无 Node 24 预编译包 |

---

## 1.5 问题总览（本次在 Windows 上实际发现、已逐个复现）

> 下列问题均在真实 Windows + Node 24 环境下实际触发过（多数直接阻断“安装 / 启动 / 运行任务”）。按章节可查到根因与修复。

| # | 问题 | 影响阶段 | 严重度 | 章节 |
|---|---|---|---|---|
| 1 | 目录/只读句柄 fsync（`openSync(dir,'r')` + fsync） | 安装 | 阻断 | 5.1–5.5 |
| 2 | `fs.symlink` 普通用户无权限 | 安装 | 阻断 | 5.3–5.6 |
| 3 | junction 的 readlink 返回绝对路径 | 运行 | 阻断（启动失败） | 5.7 |
| 4 | 错误被吞（`native install transaction aborted`） | 安装 | 诊断性 | 5.8 |
| 5 | better-sqlite3 ABI 与 Node 版本不匹配 | 安装 | 阻断 | 6 |
| 6 | Windows 上仍打印 Linux 的 `export PATH` 提示 | 安装 | 小 | 5.9 |
| 7 | `resolveExecutorTool` 用 `X_OK` 误判可执行性 | 执行器 | 阻断（找不到 pi） | 5.10a |
| 8 | `spawn` 缺 `shell`，无法启动 `.cmd` shim | 执行器 | 阻断 | 5.10b |
| 9 | `execFile` 无 shell 选项 / 丢自定义 promisify / 3 参重载 | 执行器 | 阻断 | 5.10c |
| 10 | planner `spawn(<cli.js>)` 直接跑 `.js` → `EFTYPE` | 执行器 | 阻断 | 5.10d |
| 11 | `openBrowser` 用 `spawn('start', …)`（cmd 内建）→ ENOENT | 客户端 | 中 | 5.10e |
| 12 | `rename` 覆盖已存在 junction → `EPERM` | 运行 | 阻断（激活失败） | 5.11 |
| 13 | 路径越界检查 `startsWith(dir + '/')`（dist 内共 **7 处**） | 运行 | 阻断（新建会话/运行时 home 等） | 5.12 |
| 14 | 模型预设名与 provider 实际模型名不一致 | 配置 | 阻断（Planner 400） | 5.13 |
| 15 | `pi-pdf` 只读 → Python 字节码无法缓存 → 探测超时 | 执行器 | 阻断（执行器不可用） | 5.14 |
| 16 | worktree 后端依赖系统 git，发布包未捆绑/未配 PATH | 执行器 | 阻断（`spawn git ENOENT`） | 5.15 |
| 17 | git ref 路径超长（360 字符）> Windows MAX_PATH | 执行器 | 阻断（`update-ref` 失败） | 5.16 |
| 18 | 官方授权内存态，重启 Server 即需重新登录 | 运维 | 中 | 5.17 |
| 19 | 给 `.cmd` shim 用 `shell:true` → cmd.exe 截断长参数（提示词被打碎） | 执行器 | **严重**（任务 done 但产物错） | 5.18 |

---

## 2. 修复总原则

1. **安装阶段**：目录/只读句柄的 fsync 在 Windows 上跳过（rename 已保证原子性）；`symlink` 一律走平台封装（目录→junction，文件→硬链接）。
2. **运行阶段**：**所有** `readlink`/`readlinkSync` 调用点，必须走统一的归一化封装，把 junction 的绝对目标转回相对路径。
3. **ABI**：发布时保证 better-sqlite3 与目标 Node 的 ABI 一致（见第 6 节）。
4. **错误可见**：安装器失败时必须抛出真实错误，而不是 `native install transaction aborted`。

---

## 3. 第一步：全量审计（必须做）

在源码根目录执行，找出**所有**同类调用点，避免漏改：

```powershell
Get-ChildItem -Recurse -Include *.ts,*.tsx,*.mjs,*.js -Path src |
  Select-String -Pattern "open\([^,]+,\s*'r'\)|openSync\([^,]+,\s*'r'\)|\.sync\(\)|fsyncSync|symlink\(|readlink\(|readlinkSync\(|chmod\(" |
  Select-Object Path, LineNumber, Line
```

**特别重点排查 `readlink(` / `readlinkSync(`**——这是运行阶段能否启动的关键，任何一个漏掉都会导致 `server start` 失败。

---

## 4. 新增平台工具模块

新建 `src/installation/fs-platform.ts`，集中处理平台差异，所有调用点统一改用它：

```ts
import { openSync, fsyncSync, closeSync, readlinkSync } from 'node:fs';
import { open, symlink, readlink, link, lstat, copyFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

const isWindows = process.platform === 'win32';

/** 文件 fsync：Windows 下只读句柄无法 fsync，且 rename 已保证原子性，跳过。 */
export async function syncFile(path: string): Promise<void> {
  if (isWindows) return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** 目录 fsync：Windows 下 open(dir, 'r') 抛 EISDIR，跳过。 */
export async function syncDirectory(path: string): Promise<void> {
  if (isWindows) return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** 同步版（供 upgrade-journal.ts 等同步代码使用）。 */
export function syncFileSync(path: string): void {
  if (isWindows) return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * 相对目标链接。Windows 普通用户不能建符号链接：
 * - 目录 → junction（无需管理员权限）
 * - 文件 → 硬链接（同卷内无需权限）
 */
export async function createRelativeLink(path: string, target: string): Promise<void> {
  if (!isWindows) {
    await symlink(target, path);
    return;
  }
  const absoluteTarget = resolve(dirname(path), target);
  let isDir = false;
  try { isDir = (await lstat(absoluteTarget)).isDirectory(); } catch { /* 目标暂不存在 */ }
  if (isDir) {
    await symlink(absoluteTarget, path, 'junction');
  } else {
    try { await link(absoluteTarget, path); } catch { await copyFile(absoluteTarget, path); }
  }
}

/** 创建带类型提示的目录链接（原来写死 type='dir' 的调用点）。 */
export async function createDirectoryLink(path: string, target: string): Promise<void> {
  if (!isWindows) { await symlink(target, path, 'dir'); return; }
  const absoluteTarget = resolve(dirname(path), target);
  await symlink(absoluteTarget, path, 'junction');
}

/**
 * 【运行阶段关键】junction 的 readlink 返回绝对路径（如 \??\C:\...），
 * 必须统一转回相对路径，否则所有 readlink 消费方（如 readActiveRevisionId）都会错。
 */
export function normalizeLinkTarget(result: string, linkPath: string): string {
  if (!isWindows) return result;
  const cleaned = result.replace(/^[\\?]+(?=[A-Za-z]:)/, '');
  return isAbsolute(cleaned) ? relative(dirname(linkPath), cleaned) : result;
}

/** 归一化读取链接目标（替代所有直接 readlink 调用）。 */
export async function readLinkTarget(linkPath: string): Promise<string> {
  const result = await readlink(linkPath);
  return normalizeLinkTarget(result, linkPath);
}

export function readLinkTargetSync(linkPath: string): string {
  const result = readlinkSync(linkPath);
  return normalizeLinkTarget(result, linkPath);
}

/** Windows 上 rename 覆盖已存在的 junction/符号链接会 EPERM；先移除目标再 rename。 */
export async function renameOverwrite(oldPath: string, newPath: string): Promise<void> {
  if (isWindows) {
    try {
      const st = await lstat(newPath);
      if (st.isSymbolicLink()) await rm(newPath, { force: true });
    } catch { /* 目标不存在 */ }
  }
  await rename(oldPath, newPath);
}
```

> `makeImmutable`/`makeWritable` 里的 `chmod` 在 Windows 上只是切换"只读属性"，不会导致安装失败；建议在 `isWindows` 时跳过 `chmod`，保持行为一致。

---

## 5. 按文件修复清单

### 5.1 `src/installation/upgrade-journal.ts`
- 位置：`UpgradeJournal.persist()`
- 问题：`openSync(temp,'r') + fsyncSync`、`openSync(parent,'r') + fsyncSync`
- 修复：改用 `syncFileSync(temporaryPath)`、`syncDirectorySync(parent)`

### 5.2 `src/installation/native-launcher.ts`
- 位置：`installNativeLauncher()`
- 问题：`open(temp,'r') + handle.sync()`、`open(dirname,'r') + directory.sync()`
- 修复：改用 `await syncFile(temporary)`、`await syncDirectory(dirname(path))`

### 5.3 `src/installation/account-layout-migrator.ts`
- 位置：`writeAtomicJson()`
- 问题：`open(temp,'r') + sync`、`open(parent,'r') + sync`
- 修复：改用 `await syncFile(temporary)`、`await syncDirectory(parent)`

- 位置：`populateStage()`
- 问题：`symlink(join('database-revisions', ...), ...)`
- 修复：`await createRelativeLink(path, join('database-revisions', basename(stagedDatabase)))`

- 位置：`rebuildConfigurationActivePointer()`
- 问题：`readlink(sourceActive)` + `symlink(..., 'dir')`
- 修复：`await readLinkTarget(sourceActive)` + `await createDirectoryLink(targetActive, join('revisions', basename(target)))`

### 5.4 `src/configuration/file-configuration-repository.ts`
- 位置：`writeRevision()` 内联的 `syncFile`/`syncDirectory`
- 修复：改用平台工具模块的 `syncFile`/`syncDirectory`

- 位置：`replaceActivePointer()`
- 问题：`symlink(join('revisions', revisionId), temporaryPath, 'dir')`
- 修复：`await createDirectoryLink(temporaryPath, join('revisions', revisionId))`

- 位置：`readActiveRevisionId()` —— **【运行阶段关键，漏改必失败】**
- 问题：`readlink(this.activePath)` 返回 junction 的绝对路径，`revisions/` 前缀判断失效
- 修复：`const target = await readLinkTarget(this.activePath)`

- 位置：文件底部重复定义的 `syncFile`/`syncDirectory`
- 修复：删除本地定义，统一从 `fs-platform.ts` 导入

### 5.5 `src/configuration/activation-journal.ts`
- 位置：`write()` 内联的 `syncFile`/`syncDirectory`；文件底部本地定义
- 修复：改用平台工具模块并删除本地定义

### 5.6 `src/installation/source-native-installer.ts`
- 位置：`replaceRelativeSymlink()`
- 问题：`symlink(target, temporary)`
- 修复：`await createRelativeLink(temporary, target)`

- 位置：`assertReleaseRootReplaceable()`
- 问题：`readlink(appCurrentPointer)` 在 junction 下返回绝对路径
- 修复：`await readLinkTarget(appCurrentPointer)`

- 位置：`makeImmutable()`/`makeWritable()`
- 修复：`isWindows` 时跳过 `chmod`

### 5.7 【运行阶段】全部 `readlink` 调用点清单

这是"安装成功后 `metawork server start` 能否启动"的关键。**审计出的每一个 `readlink`/`readlinkSync` 都必须替换**：

| 文件 | 调用点 | 修复 |
|---|---|---|
| `src/configuration/file-configuration-repository.ts` | `readActiveRevisionId()` | → `readLinkTarget` |
| `src/installation/source-native-installer.ts` | `assertReleaseRootReplaceable()` | → `readLinkTarget` |
| `src/installation/account-layout-migrator.ts` | `rebuildConfigurationActivePointer()` | → `readLinkTarget` |
| `src/installation/account-layout-migrator.ts` | `collectManifest()` 内 `readlink(entryPath)` | → `readLinkTarget` |

> 注意：`collectManifest()` 会把链接目标写进 manifest 并做哈希校验，junction 若读回绝对路径会导致 manifest 哈希不稳定；必须用 `readLinkTarget` 归一化为相对路径。

### 5.8 （建议）错误透传
- `src/session/server-update-coordinator.ts`：`ServerUpdateResult` 增加 `error: string | null`，`performUpdate` 的 catch 带上原始错误。
- `src/install-cli.ts`：`runOfflineNativeTransaction` 在 `outcome !== 'committed'` 时优先抛 `coordinated.error` / `operationError`，让用户看到真实原因。

### 5.9 （小问题）Windows 成功提示
- `src/install-cli.ts` 安装成功提示按平台输出：
  - Windows：`%LOCALAPPDATA%\MetaWork\bin\metawork.cmd --help`
  - Linux/macOS：`export PATH="$HOME/.local/bin:$PATH" && metawork --help`

### 5.10 【Windows】pi/codex executor "找不到" —— 三层问题，都要修

#### 5.10a 命令解析错：`executableFile` 在 Windows 上误判可执行性
- 位置：`src/utils/executor-tool-path.ts` 的 `executableFile()` 与 `resolveExecutorTool()`
- 问题：`executableFile(path)` 用 `accessSync(path, X_OK)` 判断可执行。**Windows 上 `X_OK` 对任意存在的文件都返回成功**，于是 `resolveExecutorTool('pi')` 把 `pi` 解析成无扩展名的 bash shim（`...\npm\pi`），而不是真正可执行的 `pi.cmd`。
- 修复：Windows 下 `executableFile` 只认 `.exe`/`.com`；`resolveExecutorTool` 按 `PATHEXT` 顺序解析，命中 `.cmd`/`.bat`/`.exe` 时返回对应完整路径，**不要返回无扩展名脚本**。
- 验证：Windows 上 `resolveExecutorTool('pi')` 应返回 `...\npm\pi.cmd`。

#### 5.10b spawn 没加 shell：`.cmd` 不能被 CreateProcess 直接启动
- 位置：`src/executor/local-cli-executor-adapter.ts` 的 `SpawnLocalCliChildProcessRunner.run()`
- 问题：`spawn(command, args, { ..., windowsHide: true })` 没有 `shell`。即使命令解析成 `pi.cmd`，`.cmd` 也无法被 CreateProcess 直接启动 → `spawn ENOENT`（表现就是"找不到 pi"，即使 pi 已安装）。
- 修复：Windows 下加 `shell: process.platform === 'win32'`；或显式用 `cmd.exe /d /s /c` 启动。该 harness 的 `command`/`args` 来自 MetaWork 自身配置（`pi`/`codex`，args 通常为空），注入风险可控。
- 关联：`codex-cli`（`command: codex`）同样受影响。

#### 5.10c 探测/执行还走了 `execFile`：需转 `exec` 并保留自定义 promisify
- 位置：`src/executor/pi-cli-driver.ts`、`src/executor/codex-cli-driver.ts` 的 `defaultProbeCommand()`（内部 `execFileAsync = promisify(execFile)`）
- 问题 1：`execFile` 没有 `shell` 选项（它的语义就是“不经过 shell”），Windows 上无法启动 `.cmd`/无扩展名 shim → `ENOENT`。
- 问题 2：Node 的 `execFile` 自带 `Symbol.for('nodejs.util.promisify.custom')`，`promisify(execFile)` 会 resolve 成 `{ stdout, stderr }` 对象；任何包装/替换若丢失该符号，`result.stdout` 会变成 `undefined`。
- 问题 3：Node 内部 `exec()` 是以 `execFile(file, options, callback)` 这种 3 参重载调用 `execFile` 的；包装时归一化写错会把 callback 弄丢，导致回调永不触发。
- 修复（源码层）：
  - Windows 上 `defaultProbeCommand` 直接改用 `exec`（自带 shell）替代 `execFile`，或对 shim 命令改用 `spawn(..., { shell: true })`；
  - 若仍要包一层 `execFile`：必须正确处理三种重载 `(file)` / `(file, args, options, cb)` / `(file, options, cb)`，并重新挂上 `Symbol.for('nodejs.util.promisify.custom')`（resolve `{ stdout, stderr }`）。
- 关联：`codex-cli` 的探测同样受影响。

#### 验证（三层都修好后，三种方式都应输出 1.2.0）
```powershell
# 1) spawn（executor 运行路径）
node -e "const {spawn}=require('child_process');const c=spawn('pi',['--version'],{windowsHide:true});c.stdout.on('data',d=>process.stdout.write(d));c.on('error',e=>console.log('SPAWN_ERROR',e.code));"

# 2) execFile（探测路径，回调形式）
node -e "const {execFile}=require('child_process');execFile('C:/Users/admin/AppData/Roaming/npm/pi',['--version'],{timeout:5000},(e,so)=>{console.log(e?'ERR '+e.code:'OK',so.trim());});"

# 3) promisify(execFile)（defaultProbeCommand 的真实形式，必须拿到 result.stdout）
node -e "const {execFile}=require('child_process');const {promisify}=require('util');promisify(execFile)('C:/Users/admin/AppData/Roaming/npm/pi',['--version'],{timeout:5000,maxBuffer:65536}).then(r=>console.log('OK',r.stdout.trim())).catch(e=>console.log('ERR',e.code));"
```

必须三种方式都正常输出 `1.2.0`，且不再出现 `SPAWN_ERROR ENOENT`。

#### 5.10d planner 用 `spawn()` 直接跑 `.js` 文件 → `spawn EFTYPE`
- 位置：`src/planning/planner-process-supervisor.ts` 的 `resolveLaunch()`（命令来自 `METACLAW_PLANNER_COMMAND`，指向 `.../planner/packages/coding-agent/dist/cli.js`）
- 问题：`spawn(command, args)` 直接执行 `.js` 文件。POSIX 靠 shebang + 可执行位可以；Windows 上 `.js` 不是 PE 可执行文件 → `spawn EFTYPE`（表现为 `Planner unavailable: spawn EFTYPE`）。
- 修复：Windows 上当命令以 `.js`/`.mjs`/`.cjs` 结尾时，改用 `spawn(process.execPath, [脚本, ...args])`（源码层在 `resolveLaunch` 对 `.js` 命令前置 `process.execPath`）。
- 验证：`node -e "require('child_process').spawn('.../cli.js',['--version'])"` 不再 EFTYPE，能输出版本号。

#### 5.10e 其余 child_process 调用点（executor / TUI 客户端 / 打开浏览器）
同一类问题还出现在：
- `src/executor/local-cli-executor-adapter.ts`、`src/execution/worktree-attempt-execution-backend.ts`：`spawn(pi/codex 命令)` —— 命令来自 `resolveExecutorTool()`，Windows 上是无扩展名 shim / `.cmd`，需 shell。
- `src/executor/pi-cli-driver.ts`、`src/executor/codex-cli-driver.ts`、`src/executor/tool-validation.ts`、`src/management/agent-installation-readiness-service.ts`：`execFile(命令)` —— 同上；`execFile` 没有 shell 选项，需转 `exec`（或先解析到 `.cmd`）。
- `src/client/tui-client-launcher.ts`：`spawn(vendored planner 命令)` —— 同 planner，命令是 `.js`，需 `node` 前置。
- `src/client/client-command.ts` 的 `openBrowser()`：`spawn('start', [url])` —— `start` 是 cmd.exe 内建命令，PATH 里没有对应可执行文件，Windows 上直接 `ENOENT`；且 `openBrowser` 没挂 `error` 监听，会连带让客户端进程崩溃。应改为 `spawn('cmd.exe', ['/d','/s','/c','start','',url])` 或 `shell: true`。

统一修复原则（源码层）：新增进程启动封装（如 `src/utils/process-platform.ts`）：
- `.js`/`.mjs`/`.cjs` → `spawn(process.execPath, [脚本, ...args])`
- `.cmd`/`.bat` 若是 **npm shim**（内容形如 `node "<entry.js>" %*`）→ 解析出入口，`spawn(process.execPath, [entry, ...args])`（**不要用 `shell:true`**，见 5.18）；非 shim 才用 `shell:true`
- `start` 等 cmd 内建 → `cmd.exe /d /s /c`
然后所有 `spawn`/`execFile` 调用点统一改用它。

### 5.11 【Windows】rename 覆盖已存在的 junction/符号链接会 EPERM
- 位置：`src/configuration/file-configuration-repository.ts` 的 `replaceActivePointer()`；`src/installation/source-native-installer.ts` 的 `replaceRelativeSymlink()`
- 问题：这两处“原子指针切换”都是 `symlink(temp) → rename(temp, final)`。Windows 上 `rename` 覆盖一个**已存在的 junction/符号链接**会抛 `EPERM`（POSIX 是覆盖语义，Windows 不是），导致激活失败：`EPERM: operation not permitted, rename '.active-xxx' -> 'active'`。
- 修复：统一改用 `fs-platform.ts` 的 `renameOverwrite()`（Windows 下先移除已存在的 symlink 目标再 rename）。
- 验证：Windows 上连续两次激活配置（第二次覆盖已有 junction）不再 EPERM。

### 5.12 【Windows】路径越界检查用 `startsWith(dir + '/')` 会误判
- 位置（源码）：`src/session/file-conversation-store.ts`、`src/storage/file-conversation-presentation-store.ts`、`src/storage/file-attachment-store.ts` 的 `recordPath()`；`src/executor/runtime-home-materializer.ts` 的 `resolveInside()`（runtime home）。**打包进 dist 后共 7 处**需处理：`recordsDir`×2、`rootDir`×1、`resolveInside`×1、`realImportParent`×1、`left/right` 包含判断×1、`key2` root×1
- 定位命令（在 dist 目录执行）：`Select-String -Pattern '\.startsWith\(`'`，把结尾带 `/` 的都检查一遍
- 问题：`resolve(dir, name)` 在 Windows 返回反斜杠路径，而 `path.startsWith(`${dir}/`)` 用正斜杠做前缀比较，永远为 false → 误抛 `Invalid conversation id`，导致“新建会话”失败。
- 修复：用平台无关的路径包含判断：`relative(dir, path)` 后判断是否为 `..`/绝对路径；或比较前两侧统一 `replaceAll('\\', '/')`。建议在 `fs-platform.ts` 增加 `isInsideDirectory(dir, path)` 助手统一替换。
- 验证：Windows 上 `POST /api/workspaces/:id/conversations` 返回 201 且会话创建成功。

### 5.13 【非 Windows 专属】模型预设与 provider 实际模型名不一致
- 位置：`src/configuration/public-provider-catalog.ts`（`PUBLIC_PROVIDER_PRESETS`）
- 问题：`deepseek` 预设的 `modelIds` 列了 `deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-v4-flash-vision-exp` 等（这些其实是 OpenRouter 目录里的名字），但 DeepSeek 官方 API（`api.deepseek.com`）实际只接受 `deepseek-flash`、`deepseek-v4-pro`。用户选了预设里的名字，请求时被 API 以 400 拒绝：`The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash`。
- 修复：让预设的 `modelIds` 与该 provider 实际 API 的模型名对齐；配置时不要把 OpenRouter 的 `catalogModelId` 直接当作 provider 请求用的模型名。
- 规避：选 provider 实际支持的模型（如 `deepseek-v4-pro`）。

### 5.14 【Windows】执行器探测失败：pi-pdf 只读导致 Python 字节码无法缓存 → 超时
- 位置：`src/executor/pi-cli-driver.ts` 的 `probe()`（PDF 检查）+ `src/installation/source-native-installer.ts` 的 `makeImmutable()`
- 问题：`probe()` 用 5 秒超时执行 `python.exe -I -c "import pypdf,pdfplumber,pypdfium2,PIL"`。`makeImmutable` 把整个 `dist/pi-pdf` 设为只读（Windows 上 chmod 0o555/0o444 → 只读属性），Python 无法写 `__pycache__`，**每次 import 都从源码重新编译（实测 ~4.3s）**，逼近/超过 5s 超时 → 探测失败 `Pi PDF installation is incomplete:` → 执行器不可用 → 任务 `capacity unavailable` 卡住、attempt 变 stale。
- 规避（即时）：清除只读并预热字节码：
  ```powershell
  $pdf = "$env:LOCALAPPDATA\MetaWork\app\current\dist\pi-pdf"
  attrib -R "$pdf\*" /S /D
  & "$pdf\python\python.exe" -I -c "import sys;sys.path.insert(0,sys.argv[1]);import pypdf,pdfplumber,pypdfium2,PIL" "$pdf\site-packages"
  ```
  之后 import 降到 ~1s。
- 修复（源码）：`makeImmutable` 在 Windows 上不要把 `pi-pdf`（Python 运行环境）设为只读；或发布时预编译 `.pyc` 随包分发；或把 PDF 检查超时放大，且不把它作为“执行器可用性”的硬门槛。

### 5.15 【Windows】执行器报 `spawn git ENOENT`：worktree 后端依赖系统 git
- 位置：`src/execution/managed-git-workspace.ts`（worktree 后端用 git）；启动器写死 `METACLAW_EXECUTOR_BACKEND=worktree`
- 问题：Windows CLI 发布包**不自带 git**（`app/current` 下无 `desktop-tools`），Windows 启动器也没把自带工具加进 PATH（POSIX 启动器加了 `desktop-tools/git/bin`，Windows 漏了）；而 worktree 执行后端必须用 git → `spawn git ENOENT` → `attempt_exception`。
- 规避（即时）：装一个 git，并保证它出现在 **Server 进程**的 PATH 里（不只是用户 PATH）。注意：Server 进程的环境在启动时就固定——只加用户 PATH 的话，**已经在跑的 Server 仍找不到 git**，要么重启 Server，要么把 `git.cmd` 放到一个**当前 Server PATH 已包含的目录**（如 `%APPDATA%\npm`）转发到便携版 git。本项目实测即用后者。
- 修复（源码/发布）：安装器检测/捆绑 git（或 portable git）并在 **launcher/执行器环境**里把它加进 PATH（POSIX 启动器已加 `desktop-tools/git/bin`，Windows 启动器漏了）；或提供不需要 git 的后端 / 直接用 container 后端。

### 5.16 git ref 路径超长：`git update-ref` 报 `unable to create directory`（Windows MAX_PATH）
- 位置：`src/execution/managed-git-workspace.ts` 写入 `refs/metaclaw/generations/<64位hash>/<64位hash>/source`
- 问题：完整 ref 文件路径达 **360 字符**，超过 Windows 默认 MAX_PATH（260）→ `fatal: ... unable to create directory for <path>`。
- 规避（即时）：`git config --global core.longpaths true`（Git for Windows 会用 `\\?\` 前缀绕过限制）。实测修复前 `exit=128`，修复后 `exit=0`。
- 修复（发布）：发布时/启动器里预设 `core.longpaths=true`；或缩短 ref 路径（用短 hash / 扁平化层级）。

### 5.17 【运维】官方授权是内存态：每次重启 Server 都要重新登录
- 位置：`src/authorization/local-authorization-service.ts`（注释："One memory-only session per Server"）
- 现象：任务被拒 `official_authorization_required` → "请在本机 Web / Desktop 登录 MetaWork 官方账号并刷新权益"。
- 原因：官方账号登录 token **只存内存，重启 Server 即登出**。排查/修复过程中反复重启服务，就会把登录态清掉（本次就是如此）。
- 规避：在 Web 里重新用官方账号登录（`POST /api/official-auth/login`，email/password），登录后任务即可准入。
- 建议：如需频繁重启，考虑提供登录态持久化或“保持登录”。

### 5.18 【重要】不要给 `.cmd` shim 用 `shell: true`：cmd.exe 会截断/破坏长参数
- 位置：`src/executor/pi-cli-driver.ts` 的 `buildLaunch()` —— 把**完整任务提示词作为最后一个命令行参数**传给 pi（`args: ['--mode','json',...,input.prompt]`）；`local-cli-executor-adapter.ts` 用 `spawn(command, args)` 启动
- 问题：为绕过“Windows 不能直接 spawn `.cmd`”，临时方案给 `.cmd` shim 加了 `shell: true`（走 cmd.exe）。**cmd.exe 命令行有 ~8191 字符上限，且会破坏换行/特殊字符** → pi 收到被打碎的提示词（只看到 `[MetaClaw`、`Subtask`、`Execution`、`Context`、`v1]` 这类碎片），任务显示 `done` 但**产物错误**（执行器反过来问用户要任务内容）。
- 正确修复：`.cmd` shim 如果是 **npm 生成的**（内容形如 `"%dp0%\node_modules\<pkg>\...\cli.js" %*`），就解析出 node 入口脚本，改用 `spawn(process.execPath, [entry, ...args])` **直接启动（不走 shell）**，参数原样传递；非 npm shim 才回退 `shell: true`。
- 验证：`spawn('pi', ['--version'])` 不再经 cmd.exe；用长提示词跑任务时 pi 能收到完整文本。

---

## 6. better-sqlite3 / Node 版本策略

三个方案，按推荐度排序：

### 方案 A（最稳，推荐）：安装器自带固定 Node 运行时
- 发布包附带固定版本 Node（ABI 固定），`install-cli.js` 与运行时都用这个 Node。
- better-sqlite3 只针对一个 ABI 构建，永远匹配。
- 与桌面版 `desktop-tools/node` 思路一致，可复用。
- 代价：发布包体积增大。

### 方案 B（简单，可接受）：固定要求 Node 22 LTS
- 发布继续用 Node 22 构建；安装脚本把版本检查改成"必须是 22.x"，否则明确提示 + 下载链接。
- 优点：改动最小；缺点：Node 23/24 用户要先装 Node 22。

### 方案 C（复杂，不推荐单独用）：单包多 ABI
- 发布包带多个 `better_sqlite3.node`（ABI 127/137/...），运行时按 `process.versions.modules` 选择。
- 维护成本高；仅在不想捆绑 Node、又想支持多版本时用。

> 结论：优先 A；短期过渡用 B。**无论 A/B，都不要在安装时执行 `npm install`/`npm rebuild`。**

---

## 7. 重新构建与发版步骤

1. 按第 3 节审计 + 第 4、5 节修复源码，提交 PR。
2. 用**目标 Node 版本**（方案 B 为 Node 22.x；方案 A 为自带 Node）构建：
   ```powershell
   npm ci
   npm run build
   ```
3. 按现有 `scripts/build-release.mjs` / `package-release.mjs` 流程重新产出：
   - `manifest.win32-x64.json`
   - `metawork.zip`（含 `dist/`、`node_modules/`、`package.json`、`web/dist`、`planner` 等）
   - `planner.zip`
4. 解包 `metawork.zip` 后手动确认：
   ```powershell
   node -e "require('./node_modules/better-sqlite3')"
   ```
   必须成功（无 ABI 报错）。
5. 上传 GitHub Release，替换旧的 `manifest.win32-x64.json`。

---

## 8. 简化后的安装脚本（示意）

源码修好、ABI 匹配后，`metawork-install.ps1` 不需要 preload、不需要 npm 升级：

```powershell
# 检查 Node 版本（方案 B 示例：只接受 22.x）
$nodeVersion = & node --version
if ($nodeVersion -notmatch '^v22\.') {
  throw "MetaWork 需要 Node.js 22 LTS（当前 $nodeVersion）。请到 https://nodejs.org/ 安装后重试。"
}

# ...下载 manifest、验签、下载 metawork.zip / planner.zip、校验 SHA256、解压...

# 直接调用原生安装器（无需 --import，无需 npm install）
& node (Join-Path $runtimeRoot 'dist\install-cli.js') install $metadata.releaseId `
  '--source-root' $runtimeRoot '--planner-root' $plannerRoot
if ($LASTEXITCODE -ne 0) { throw "MetaWork installer failed with exit code $LASTEXITCODE." }
```

（方案 A 则把上面的 `node` 换成发布包自带的 Node 路径，版本检查可省略。）

---

## 9. 测试清单（发布前必须全过）

在**全新 Windows 10/11 普通账户**（非管理员、未开开发者模式）上验证：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 一条命令安装 | `.\metawork-install.ps1` 成功，无 preload、无 npm install |
| 2 | **安装后直接启动** | `metawork server start` 输出 `MetaWork Server ready`，**不出现** `RecoveryBlockedError` / `native install transaction aborted` |
| 3 | 重复运行安装脚本 | 走 update 分支，成功或给出明确提示 |
| 4 | 更新到新版本 | update 成功，`app\current` 正确切换 |
| 5 | 回滚 | rollback 成功 |
| 6 | 卸载（`-Uninstall`） | 安装目录被清理 |
| 7 | 杀软开启 / 受控文件夹访问 | 不因权限报错（junction + 普通文件操作） |
| 8 | Node 22 与 Node 24（或方案 A 的自带 Node） | 均能安装并启动 |
| 9 | 启用 pi-cli / codex-cli executor 并跑一次任务 | 能正常 spawn `pi`/`codex`，不再 `spawn ENOENT` |
| 10 | 连续两次激活/修改配置 | 第二次激活不再 `EPERM: rename '.active-xxx' -> 'active'` |
| 11 | 新建会话 / 附件上传 | 返回 201，会话创建成功，不再 `Invalid conversation id` |
| 12 | 发起任务（触发 planner） | planner 正常启动，不再 `spawn EFTYPE` |
| 13 | `metawork web` 打开浏览器 / `metawork tui` | 浏览器/TUI 正常启动，不再 `spawn ENOENT` |
| 14 | git worktree 写入超长 ref（`refs/metaclaw/generations/<hash>/<hash>/source`） | 开启 `core.longpaths` 后成功，不再 `unable to create directory` |
| 15 | **端到端**：登录官方账号 → 发起一次完整 web 研究任务（`pi-research` executor） | 产出**带来源引用、标注不确定性**的完整报告；提示词完整传递（不被 cmd.exe 截断）；任务 `done`、attempt `completed`、executor `healthy` |
| 16 | 重启 Server | 重新登录官方账号后任务可准入（当前为内存态；建议改进为可持久化） |

> 第 2 条是本次排查暴露出来的**强制回归项**：以前只验证"安装成功"是不够的，必须验证"启动成功"。
> 第 15 条是最关键的端到端验收：本次修复后已实测跑通（见下），产出了一份完整的上海天气预报报告（含 10 个来源、日/夜天气、高低温、降水概率、风、空气质量，并显式标注了缺口与交叉源分歧）。

---

## 10. 验收标准

- [ ] `metawork-install.ps1` 无 `--import` 补丁、无 `npm install/rebuild` 步骤。
- [ ] 普通 Windows 用户**一条命令**安装成功。
- [ ] 安装后**直接 `metawork server start`** 启动成功（输出 `MetaWork Server ready`）。
- [ ] 全程无需管理员权限、无需开发者模式。
- [ ] 所有 `readlink`/`readlinkSync` 调用点已改为 `readLinkTarget`（junction 绝对目标 → 相对路径）。
- [ ] 安装器报错时显示真实错误（不再是 `native install transaction aborted`）。
- [ ] Node 版本与 better-sqlite3 ABI 始终一致（方案 A 或 B 落地）。
- [ ] Windows 成功提示正确（不再显示 Linux 的 `export PATH`）。
- [ ] Windows 上 local-cli executor（`pi`/`codex`）能被正常 spawn（不再 `spawn ENOENT`）。
- [ ] 普通用户工作流可完整跑通：安装 → `metawork server start` → 登录官方账号 → 发起任务 → **产出正确报告**（不因 cmd.exe 截断导致产物错误）。
- [ ] 发布时已处理 git 依赖（捆绑或检测+配 PATH）与 git ref 长路径（`core.longpaths=true`）。

---

## 附录：临时补丁方案（不改源码、不重新发版时的应急记录）

> 本附录记录“在不改源码/不重新发版的前提下，让现有坏包在 Windows 上跑起来”的临时方案及踩坑。正式按第 4、5 节修复后，这些临时补丁应全部移除。

### A. 方案形态
- 单个 preload 文件 `metawork-win-patch.mjs`，通过 `node --import <url>` 在进程启动前注入。
- **两个注入点，缺一不可**：
  1. 安装进程：`node --import <patch> dist/install-cli.js install ...`
  2. 运行时进程：把补丁持久化到 `%LOCALAPPDATA%\MetaWork\bin\`，并把 `metawork.cmd` 最后一行 `node ...` 改为 `node --import "<file:///.../metawork-win-patch.mjs>" ...`
- 补丁内容：Windows 下改写 `node:fs`（目录 fsync 跳过、symlink→junction/硬链接、readlink 归一化、rename 覆盖 symlink）和 `node:child_process`（`.js`→node 前置、**npm `.cmd` shim→解析入口用 node 启动**、非 shim 的 `.cmd`/`.ps1` 与 `start` 内建→shell、execFile 转 exec 并保留 promisify）。

### B. 踩坑记录（每条对应一个真实报错）
1. `--import` 参数必须是 `file:///C:/...` URL，传 `C:\...` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME (protocol 'c:')`。
2. 补丁只注入安装进程时：安装成功、但运行时报 `RecoveryBlockedError: active configuration pointer escapes revision storage`。根因是 junction 的 readlink 返回绝对路径，而运行时 `readActiveRevisionId` 需要相对路径。**运行时也必须注入同一补丁。**
3. better-sqlite3 11.10.0 只带 Node 22（ABI 127）预编译，Node 24 报 `NODE_MODULE_VERSION 127 vs 137`；`npm rebuild` 会退回 node-gyp 且需要 Python/编译工具，失败。临时做法：`npm install better-sqlite3@latest --no-save --no-package-lock`（新版带 Node 24 预编译）。
4. spawn 只处理“裸命令”不够：`resolveExecutorTool()` 因 Windows `X_OK` 恒真，把 `pi` 解析成无扩展名的 bash 脚本绝对路径，spawn 该绝对路径仍失败。补丁要处理“无扩展名文件 → 找同级 `.cmd`”。**注意不要转 shell（见第 14 条），要解析 npm shim 的 node 入口。**
5. `execFile` 没有 shell 选项，必须转 `exec`；且要保留 `Symbol.for('nodejs.util.promisify.custom')`（否则 `promisify(execFile)` 的 `result.stdout` 为 undefined）；还要正确处理 `execFile(file, options, callback)` 3 参重载（否则 Node 内部 `exec()` 调用它时 callback 被丢，回调永不触发）。
6. `rename(temp, final)` 覆盖已存在的 junction/符号链接在 Windows 上抛 `EPERM`（激活配置时报 `rename '.active-xxx' -> 'active'`）。补丁里 `rename`/`renameSync` 在 EPERM 且目标是 symlink 时先 `rm` 目标再重试。
7. 运行时“新建会话”失败：`Invalid conversation id: conv_xxx`。根因是路径越界检查 `path.startsWith(dir + '/')` 在 Windows 上分隔符不一致（`resolve` 返回 `\`，比较用 `/`）。已给 dist 的 `recordPath`/`rootDir` 检查做 `replaceAll('\\','/')` 归一化。
8. planner 启动报 `Planner unavailable: spawn EFTYPE`。planner 命令指向 `cli.js`，Windows 上不能直接 spawn `.js` 文件。补丁里 spawn/spawnSync/execFile 对 `.js`/`.mjs`/`.cjs` 自动前置 `node`（`process.execPath`）。
9. `openBrowser()` 用 `spawn('start', [url])`，Windows 上 `start` 是 cmd 内建命令 → `ENOENT`（且无 error 监听会导致客户端崩溃）。补丁里 `spawn` 对 `start` 自动改用 `shell: true`。
10. 执行器探测失败 `Pi PDF installation is incomplete:`：`dist/pi-pdf` 被 `makeImmutable` 设成只读，Python 无法写 `__pycache__`，每次 import ~4.3s 逼近 5s 超时。临时：`attrib -R "<...>\pi-pdf\*" /S /D` 后预热一次 import（降到 ~1s）。
11. `spawn git ENOENT`：worktree 后端需要 git，发布包不自带、启动器也没配 PATH。临时：装 PortableGit（GitHub 太慢可走 npmmirror）并让 **Server 进程的 PATH** 能看到它（重启 Server，或在已含于 Server PATH 的目录放 `git.cmd` 转发）。
12. `git update-ref ... unable to create directory`：ref 完整路径 360 字符超过 Windows MAX_PATH。临时：`git config --global core.longpaths true`。
13. 任务被拒 `official_authorization_required`：官方授权是内存态，**重启 Server 即登出**。临时：走 `POST /api/official-auth/login` 重新登录（email/password）。
14. **长参数被 cmd.exe 截断/破坏**（最隐蔽）：给 `.cmd` shim 用 `shell:true` 时，pi 的**完整提示词（一个长参数）经 cmd.exe 后被打碎**（只收到 `[MetaClaw`、`Subtask` 之类碎片），任务显示 `done` 但**产物错误**。正确做法：`.cmd` 若是 npm shim，解析出 node 入口，用 `spawn(process.execPath, [entry, ...args])` 启动，参数原样传递。

### C. 临时方案的文件位置
- 运行时实际加载：`%LOCALAPPDATA%\MetaWork\bin\metawork-win-patch.mjs`
- 独立副本：`C:\Users\admin\metawork-win-patch.mjs`
- 安装脚本内嵌：`metawork-install.ps1` 中的 `$winPatch` here-string（与上面保持一致）
