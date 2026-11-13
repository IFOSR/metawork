# v0.1.19 合并集成与执行器修复(2026-10-22 调试会话)

> 状态:执行链已全部打通并在 Windows 本机验证(黄金研究任务完整跑通并发布结果);
> 源码集成收尾(13 个测试失败)留待下个专注时段。

---

## 1. 背景与总根因

黄金研究任务在 Windows 本机经历六层独立故障,逐层修复后全部打通:

| # | 故障 | 根因 | 修复 |
|---|---|---|---|
| 1 | Planner 400 `role 'developer' is not allowed` | Kimi 编码端点拒绝 OpenAI developer 角色与 max_completion_tokens;`api.kimi.com` 未被归入 Moonshot 兼容族 | `planner/.../ai/src/api/openai-completions.ts`:api.kimi.com 并入 Moonshot 族(system 角色 + max_tokens) |
| 2 | 执行器 `git update-ref` 失败 | 松散 ref 路径 >260 字符;Git for Windows 需按调用设 core.longpaths | `managed-git-workspace.ts`:withSafeDirectory 统一注入 `-c core.longpaths=true` |
| 3 | 执行器探测报 `dispatcher.close is not a function` | bun 对 npm undici 的垫片缺 close/destroy,且传 dispatcher 会破坏请求 | `planner-web-tools.ts`:bun 运行时跳过钉扎 dispatcher(SSRF 公网预检保留) |
| 4 | 执行器无法选择模型(Connection error/超时/403 Request not allowed) | **fork 将 agent 目录环境变量改名为 ANYFUSION_PLANNER_HOME**,执行器驱动仍注入旧名 PI_CODING_AGENT_DIR(被忽略)→ 回退内置 OpenAI 模型 gpt-5.4 → 携 kimi 密钥连 OpenAI | `pi-cli-driver.ts`:新旧名同时注入 + 模型绑定经 settings 种入(enabledModels 最高优先级通道) |
| 5 | 执行器配置校验失败 | 上游 v0.1.19 将校验从字节哈希重写为语义化有效配置比较;种入内容需与预期配置同构 | 采用上游 `executorRuntimeConfiguration` 契约,种入内容与预期逐键一致 |
| 6 | 执行器无 web_search/web_fetch(拒绝编造研究) | 文件式扩展在 DENIED_FLAGS 策略下从不加载(上游遗留死代码) | `planner-bootstrap.ts`:web_search/web_fetch 内联注册,`METACLAW_PI_WEB_TOOLS_ENABLED` 门控 |

另有两处独立修复:Codex 就绪探测与执行器生成的 `.cmd` 垫片需经 cmd.exe 启动
(Node ≥18.20 拒绝无 shell 执行 .cmd);内核容量重查对被阻塞执行器发起恢复
探测(修复单执行器账号的不探测死锁)。

环境干扰记录:本机 v2rayN 的路由状态曾造成 Kimi 请求时好时坏
(出口 IP 触发风控 403 Request not allowed);v2rayN 退出后消失。

## 2. 提交清单(本地 main,未推送)

| 提交 | 主题 |
|---|---|
| d0c40c45 | fix(ai): api.kimi.com 归入 Moonshot 兼容族 |
| 1954b085 | fix(planner): Executor 会话启动与联网工具注册 |
| cd5b32ea | fix(executor): agent 目录变量改名适配 + 模型绑定种入 + 环境注入 |
| 6e36720d | fix(git): core.longpaths |
| 9b07efe9 | fix(kernel): 容量重查恢复探测 |
| f8e18240 | fix(config): 运行时哈希感知绑定(后被上游语义化校验取代,见 §3) |
| b09a36e2 | fix(executor): Codex .cmd 垫片经 cmd.exe 启动 |
| 4e192516 | Merge v0.1.19(27 上游提交,607 文件) |
| 763bc3cd | test(kernel): 状态夹具对齐六态(修复 6 用例) |
| 49c5d7f5 | fix(readiness): Codex 探测经 cmd.exe 启动 |

## 3. 合并集成收尾(下个专注时段)

拉入上游 27 提交(v0.1.19:原地执行、六态收敛、服务端记忆)后,
**13 个测试失败**,分两类:

### 3.1 上游自身测试债(约 11 个,非合并引入)

`origin/main` 的六态收敛更新了内核守卫(blocked → needs_action)
但未同步其测试夹具——`origin/main` 的测试文件仍有 16 处旧
`status: 'blocked'`,在纯 origin/main 上同样失败(已核实守卫与
夹具的不一致在 upstream 即存在)。其中 6 个(容量重查族)已在
763bc3cd 修复;剩余约 10 个为恢复/续跑/重规划决策路径的同类债务
(动作名与唤醒类型亦更名,如 recover_retry_wake → dispatch_batch)。

动作:逐个将夹具对齐六态/恢复模型(参照
`src/kernel/control-kernel.ts` 现行守卫),预计半天。

### 3.2 本地修复线 × 上游原地执行(2 个,需设计决策)

- `escalates repeated aborts`(信号符号 [123] vs [-123]):Windows
  进程信号语义,疑似环境固有(与 -5 基线一致),待 Docker 复核;
- PDF 扩展路径断言:同样与 -5 基线一致,待 Docker 复核。

### 3.3 已取代的本地修复

- `executorRuntimeFileHashes` 的绑定感知哈希(本会话)被上游
  `executorRuntimeConfiguration` 语义化校验取代——上游校验按
  "有效配置"深度比较且 settings 严格相等,本地的绑定种入键
  (defaultProvider/defaultModel/enabledModels)会使
  `compare(settings, expected.settings)` 失败。

  **待办(集成核心)**:二选一——
  a. `executorRuntimeConfiguration` 的返回 settings 按绑定量种入
     同样三键(与 pi-cli-driver 种入同构),预期与实际一致;
  b. 或改用上游模型选择通道(需解除 --provider/--model 的
     DENIED_FLAGS 策略限制,属策略变更)。
  推荐 a:与现行驶动一致,不触碰策略。

## 4. 部署状态

- 本机安装:`0.1.18-local-fresh-16`(含 §1 全部修复;不含 v0.1.19
  合并后的源码变更),state: ready,黄金研究任务已在该安装上完整
  跑通并发布结果;
- 全新安装包:`.tmp/dist-release/metawork-0.1.18-local-fresh-14-*.zip`
  (同样含 §1 修复);
- 源码树:合并已完成(4e192516),待 §3 集成收尾后从合并源重新
  打包部署。
