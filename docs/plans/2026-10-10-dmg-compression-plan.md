# MetaWork macOS DMG 压缩方案（Review）

- 日期：2026-10-10
- 状态：已 review，建议按本方案调整；尚未实施
- 适用版本：当前 `0.1.9` arm64 release 样本
- 目标：在不破坏安装、首次启动、Runtime/Planner、更新、恢复和安全校验的前提下，降低下载体积和安装体积

## 1. 结论先行

当前 Electron 桌面交付模型下，不能通过改变 DMG 压缩参数或简单删除文件，把完整离线 DMG 稳定压到约 100 MB。当前样本的 DMG 为 `488,835,202` bytes（约 466.2 MiB），而单独对 `Electron Framework.framework` 做 gzip 实测已经约 127 MB。Electron Framework 还没有计入 MetaWork、Planner、Node、Git、Executor 和安装元数据，因此它构成了当前模型的硬约束信号。

因此方案分为两个目标，不能混在一个数字里验收：

1. **完整离线安装包**：保留当前 DMG 安装后即可运行的能力，先通过生产依赖树、Node 分发裁剪、allowlist 和 Planner 去重，争取从当前约 489 MB 降到约 250–320 MB；继续拆出可选 PDF runtime 后，可评估约 200–260 MB。具体数值必须以实际签名 DMG 为准。
2. **下载文件约 100 MB**：需要改变交付架构，让 DMG 只包含轻量 Bootstrap，首次启动后下载经过签名校验的完整 Runtime/Planner/Tools。仅保留当前 Electron Shell 作为 Bootstrap 仍不够，因为 Electron Framework 的压缩体积已经超过 100 MB；要达到这个目标，需要轻量原生启动器或浏览器/Server 安装器。

第一阶段应先实施低风险减重，保证用户仍可离线安装和首次使用；Bootstrap 分层交付是独立的产品和发布架构项目，不能作为一次普通打包优化直接切换。

## 2. 当前样本与体积来源

当前文件：

```text
apps/desktop/release/MetaWork-darwin-arm64.dmg
大小：488,835,202 bytes
SHA-256：e5580e8dd2a1fc0c6c6c09528ed027fd78a9dc03b241d4eb5ab0af5524f06cae
```

挂载并解包后，主要体积如下（不同文件系统显示的 MB/MiB 会有差异）：

| 位置 | 约原始大小 | 说明 |
| --- | ---: | --- |
| `Contents/Frameworks` | 288 MB | Electron Framework 约 286 MB 原始体积 |
| `Contents/Resources` | 1.3 GB | 主要是未压缩 payload |
| `Resources/payload/metawork` | 1.0 GB | 其中 `desktop-tools/node` 约 573 MB |
| `Resources/payload/planner` | 292 MB | 仍包含 workspace 和生产外的内容 |
| `desktop-tools/executor` | 169 MB | Pi/Executor 运行时 |
| `metawork/node_modules` | 126 MB | 需要重新核对生产依赖边界 |
| `metawork/dist` | 144 MB | 需要清理 source map、声明和非运行时文件 |
| `planner/node_modules` | 约 249 MB | 含 workspace 重复和开发工具 |
| `desktop-release.json` | 约 14 MB | 需要评估紧凑格式及 inventory 结构 |

当前 `desktop-tools/node` 中约 379 MB 是 `lib/node_modules`，另有约 66 MB `include`。Node 的运行时入口是 `bin/node`；npm、npx、corepack、include 以及随 Node 分发的开发工具是否需要，必须由代码审计和 smoke test 决定，不能因为它们在开发机上存在就全部带入 DMG。

## 3. 为什么原方案不足以保证 100 MB

原方案主要按“移除开发依赖、裁剪文件、Planner 去重、拆 PDF runtime”估算约 190–230 MB。这些措施仍然值得做，但有三个问题：

1. 它以旧的 0.1.8 `396,428,012` bytes 为基线，没有反映当前 0.1.9 已达到约 489 MB。
2. 它没有把 `desktop-tools/node/lib/node_modules`、`include` 和随 Node 分发的 npm/codex/lark-cli 等内容列为首要审计对象，而这些内容比单个 JSON 或少量文档更值得优先处理。
3. 它没有区分“完整离线安装包”和“约 100 MB 的下载引导包”。在当前 Electron 模型中，删除 payload 也不能消除 Electron Framework 的体积下限。

所以本方案不把“100 MB”写成当前打包流程的直接验收条件，而是把它定义为需要另立交付架构的目标。

## 4. 安装与更新链路约束

当前 DMG 不是把一个可执行文件简单复制到 Applications。实际链路是：

```text
DMG
└─ MetaWork.app
   └─ Contents/Resources
      ├─ desktop-release.json
      ├─ trusted-release-keys.json
      └─ payload
         ├─ metawork
         └─ planner
```

首次启动大致为：

```text
Electron
→ DesktopInstallation.verify()
→ verifyDesktopRelease(resources)
→ DesktopInstallation.run('install')
→ payload/metawork/desktop-tools/node/bin/node
→ dist/desktop-install-cli.js
→ 安装 Server/Runtime
```

更新和恢复还依赖已安装的 `desktop-tools/node/bin/node`、release identity、staging/rollback、runtime manifest、desktop inventory 及 helper。当前代码会读取并校验这些路径：

```text
metawork/dist/index.js
metawork/dist/desktop-install-cli.js
metawork/dist/desktop-update-cli.js
metawork/web/dist/index.html
metawork/desktop-tools/node/bin/node
metawork/desktop-tools/git/bin/git
metawork/desktop-tools/executor/bin/pi
planner/packages/coding-agent/dist/cli.js
```

任何裁剪必须发生在 inventory 和签名生成之前。不能先生成 `desktop-release.json`，再从 payload 删除文件；也不能让客户端在用户机器上运行 npm 或重新解析开发依赖。若改变 Node、Planner 或 helper 的路径，必须同步修改 `verifyDesktopRelease`、安装、更新和恢复逻辑，并增加迁移兼容测试。

## 5. 推荐实施路线

### 阶段 0：建立可重复的体积基线

在干净 checkout 中生成 arm64 和 x64 staging，分别记录：

- DMG、`.app`、`Contents/Frameworks`、`Contents/Resources` 的大小；
- `payload/metawork`、`payload/planner`、各 runtime archive 的大小；
- `desktop-release.json`、文件数、archive byteSize 和 SHA-256；
- 压缩前后目录中最大的 50 个路径；
- 当前版本、架构、签名和 notarization 状态。

每阶段只能改变一类主要变量，否则无法判断收益和回归原因。`du` 或 gzip 估算只能用于筛选，最终以实际签名 DMG 为准。

### 阶段 A：重建生产 runtime，优先裁剪 Node 分发

重点是 `scripts/build-release.mjs`、`scripts/package-release.mjs` 和 `apps/desktop/packaging/prepare-runtime.mjs`。

1. 在独立 production staging tree 中执行 `npm ci --omit=dev`，MetaWork 和 Planner 都不能从当前开发工作树原样复制 `node_modules`。
2. 对 `desktop-tools/node` 做显式 allowlist：保留 `bin/node` 及其实际运行所需的动态库和资源；默认排除 `include`、npm、npx、corepack、`lib/node_modules`、codex、lark-cli 等，只有代码审计证明运行时需要时才恢复。
3. 对 Git、Executor 和 native modules 采用平台/架构专用 staging，并保留运行时需要的许可证和动态库。
4. 对开发依赖增加构建失败规则。`typescript`、`vitest`、`vite`、`tsup`、`esbuild`、Biome、Rolldown、测试 fixture 等不能出现在最终 runtime，除非明确列入 allowlist 并有测试理由。
5. 生产目录生成完成后，才生成 archive、inventory 和签名。

预计这是收益最大且不改变用户安装模型的一步；以当前样本估算，目标先设为约 300–360 MB，实际结果以 DMG 测量为准。Node 分发裁剪必须先验证安装 CLI、Server、Planner、Executor、SQLite、Git 和更新 helper，不能只观察目录体积。

### 阶段 B：运行时 allowlist 与 Planner 去重

把发布输入从 `entries: ['.']` 改为明确的运行时布局。Planner 至少要保留当前 RPC/TUI 入口、`packages/coding-agent/dist/cli.js`、必要的 `ai`/`agent`/`tui` dist、生产 `node_modules`、package.json 和运行时资源。应排除源码、测试、fixtures、examples、构建缓存、source map、声明文件和开发文档，但要逐项确认 skill、主题、图片、HTML 模板和 MCP 资源不会被误删。

Planner workspace 当前同时存在 `packages/*` 和 `node_modules/@earendil-works/*` 的解引用副本。应设计一个 canonical runtime layout，保证 ESM package resolution 成立后只保留一份包代码。`tar -h` 不得把 workspace symlink 再次展开成重复内容。此阶段必须增加 Planner RPC、TUI、MCP、MetaWork skill 和升级恢复测试，不能只以 archive 变小为完成条件。

阶段 B 完成后，合理的阶段目标是约 250–320 MB；如果生产依赖实际仍较大，应以目录审计结果调整，不预先承诺某个精确数字。

### 阶段 C：拆分可选 PDF 和 managed tools

当前 Pi PDF Python runtime 约 102 MB 原始体积、约 40 MB gzip。只有确认 PDF 不是首次启动、核心对话和 Server readiness 的必要条件后，才可拆为按需包：

```text
核心 MetaWork DMG
└─ 可选 PDF runtime 下载包
```

按需包必须具备：releaseId、版本和架构匹配、签名 manifest、SHA-256、完整下载后的原子安装、失败重试、断网提示、半安装清理和旧版本回滚。首次使用 PDF 时应显示明确状态；PDF 包不可用时，核心聊天、Server 和普通 Planner 能力仍需可用。更新和 recovery 也必须能够重新获取或恢复该包。若还有其他可选 managed tools，应使用同一机制，不要为每个工具新增一套下载逻辑。

该阶段可能再减少约 35–45 MB DMG，但它改变了首次使用和离线能力，必须在产品确认后实施。

### 阶段 D：压缩 release descriptor

当前 `desktop-release.json` 保存了约 60,240 个文件的 inventory，pretty JSON 约 13.67 MB，紧凑 JSON 约 11.57 MB。可以把写出格式改为紧凑 JSON，或设计兼容的压缩 inventory 表示，但必须确认签名 canonicalization、旧版本读取和错误诊断仍然清晰。它最多是小幅优化，不能替代 payload 裁剪，也不能为了减少几 MB 而牺牲篡改定位能力。

## 6. 若必须让 DMG 本体约 100 MB：Bootstrap 交付

当产品硬性要求“用户下载的 DMG 约 100 MB”时，应启动独立的分层交付设计：

```text
轻量原生 Bootstrap DMG
→ 下载并验证 signed runtime bundle
→ 原子安装完整 Electron/MetaWork/Planner/Tools
→ 创建 active release
→ 启动 MetaWork
```

Bootstrap 需要负责：

- 显示首次下载大小、进度、当前阶段和预计剩余时间；
- 校验 releaseId、版本、macOS 架构、签名和每个 bundle 的 SHA-256；
- 支持失败重试；条件允许时支持断点续传，否则删除未完成包后重新下载；
- 下载完成并验证通过后才切换 active release，不能让半安装目录被当成可用版本；
- 首次下载断网时给出可恢复提示，不能伪装成普通启动失败；
- 保留旧版本或 Bootstrap 作为回滚入口；
- 对更新和首次安装使用同一套 manifest、校验、staging 和 recovery 规则。

不建议先做“Bootstrap Electron”来承诺 100 MB：当前 Electron Framework gzip 实测已经约 127 MB，它仍会超过目标。真正的 100 MB 级下载包需要轻量原生启动器，或把安装器改为浏览器/Server 交付。这个方案会引入首次联网要求、下载服务、签名密钥轮换、CDN 可用性和离线安装策略，应作为单独的发布架构变更评审。

## 7. 验收标准

### 功能与安装

- [ ] 干净 checkout 可生成 production-only staging，不依赖开发目录残留。
- [ ] Finder 打开 DMG 后能够完成安装；首次启动能通过 release verification 并启动 Server。
- [ ] Planner RPC、Planner TUI、MCP、MetaWork skill、Executor、SQLite 和 Git 均可用。
- [ ] 普通对话不依赖 PDF 可选包；PDF 拆包时首次下载、重试、断网和离线提示可用。

### 安全、更新与恢复

- [ ] Runtime manifest、desktop release signature、archive byteSize、SHA-256 和 inventory 完全一致。
- [ ] arm64/x64 的 native module、Node ABI、codesign 和 notarization 均通过。
- [ ] 升级成功、readiness 失败回滚、helper 中断恢复、旧版本启动和 managed tools recovery 均通过。
- [ ] 缺失文件、篡改文件、错误架构、未签名 bundle 和半安装目录均被拒绝。

### 体积

每个候选版本都记录实际 DMG 大小，不能以原始目录或 gzip 估算代替：

| 里程碑 | 目标 | 适用范围 |
| --- | ---: | --- |
| 阶段 A 后 | ≤ 360 MB | 保持完整离线安装模型 |
| 阶段 B 后 | ≤ 320 MB | 生产裁剪和 Planner 去重完成 |
| 阶段 C 后 | 约 200–260 MB | PDF 等可选 runtime 已拆分 |
| 100 MB 目标 | 约 100 MB | 仅适用于轻量 Bootstrap 下载包 |

如果阶段 A/B 后仍明显高于目标，应先查看实际目录审计和签名包，不应通过删除必需 runtime、绕过校验或压缩错误架构来“达标”。

## 8. 实施顺序与当前决策

1. 先补充可重复的体积审计和 clean staging 构建。
2. 重建 Node、MetaWork、Planner 和 Executor 的 production runtime，优先处理 `desktop-tools/node/lib/node_modules` 与 `include`。
3. 运行安装、Server、Planner、Executor、SQLite、Git、更新和恢复 smoke test，再确认阶段 A 的实际 DMG 体积。
4. 实施 Planner allowlist 和 workspace 去重，保持 canonical runtime layout。
5. 产品确认离线 PDF 能力边界后，再决定是否拆出 PDF/managed tools。
6. 只有在完整离线包已经稳定后，才评估轻量原生 Bootstrap；该项目必须单独设计下载、签名、断点、回滚和离线策略。

Review 阶段只更新方案文档；实施阶段按本文件的阶段 A、B 和 D 规则修改了打包流程并生成本地候选 DMG。不删除用户已有 payload，不发布 GitHub Release，也不把任何未验证的体积预测当作交付承诺。

## 9. 本次实施记录（2026-10-10）

本次已按阶段 A、B 和 D 的可逆部分实施并重新生成本地 arm64 internal DMG：

- `scripts/package-release.mjs` 改为 MetaWork/Planner 运行时 allowlist，排除 source map、声明、测试、fixtures、examples、开发脚本和已确认的开发依赖；Planner 不再打包整个 workspace。
- 新增 `scripts/prepare-node-runtime.mjs`，为 Desktop payload 生成只包含 Node 可执行文件、许可证和必要资源的最小 Node runtime；本次候选未携带 npm、npx、corepack、headers 和 `lib/node_modules`。
- `apps/desktop/packaging/prepare-runtime.mjs` 使用紧凑 JSON 写出 Desktop descriptor，仍先完成签名、inventory 和 `verifyDesktopRelease`，没有在签名后删除文件。
- PDF runtime 尚未拆包，Bootstrap 分层交付也尚未实施；因此本次仍是完整离线安装模型，100 MB 目标不适用于该 DMG。

本次候选产物：

```text
apps/desktop/release/MetaWork-darwin-arm64.dmg
大小：290,944,684 bytes
SHA-256：7d430f7bf98812a167bc605cfdae55868a4d3c4fe773a1ba28810cb37278044c
releaseId：0.1.9-internal-compressed-20261010
```

体积对比：

| 项目 | 原样本 | 本次候选 |
| --- | ---: | ---: |
| DMG | 488,835,202 B | 290,944,684 B |
| MetaWork archive | — | 68,587,049 B |
| Planner archive | — | 23,022,514 B |
| Desktop descriptor | 约 14 MB | 约 6.4 MB |

已完成验证：

- Desktop payload verifier：33970 个文件，Runtime/Planner archive hash、manifest signature、inventory、Node ABI 127、SQLite、Git、Executor 和 PDF runtime probe 通过。
- 实际挂载 DMG 后再次运行 `verifyDesktopRelease`，通过 release identity 和完整 inventory 校验。
- `apps/desktop/tests/packaged-install-smoke.mjs` 通过：干净安装、认证 Web、Server 启动与 Electron 退出后存活、设置激活和菜单检查均通过。
- `npm run build:desktop`、`npm run lint:desktop` 和 `git diff --check` 通过。

该产物是 internal/ad-hoc signed build，因为当前工作树存在用户已有未提交改动且本机没有 Developer ID identity；它可用于本地安装验证，不应当作为正式发布或 notarized DMG。阶段 C 和 100 MB Bootstrap 仍需独立设计和验收后再实施。
