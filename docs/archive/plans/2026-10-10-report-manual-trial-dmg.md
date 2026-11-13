# PDF 下载与能力手册激活修复试用 DMG

- 日期：2026-10-10
- 状态：本地 DMG 打包与验收完成，待用户安装试用
- 完成日期：2026-10-10
- 目标：macOS Apple Silicon（arm64），仅本地试用
- 应用版本：0.1.9
- 内部 Release ID：`0.1.9-internal-local20261010b`
- Git：用户明确要求暂不提交或发布

## 内容

- [Markdown / PDF 下载](2026-10-10-report-md-pdf-download.md)。
- [能力手册长度导致激活失败修复](2026-10-10-executor-manual-activation-fix.md)。
- 包含当前已完成的官方账号与内置 AI 客户端逻辑。

## 构建

使用当前未提交源码构建 Runtime/Web/Desktop，在独立目录安装生产依赖。
Planner 源码未变，复用上一份已验证的 Planner 构建。
正式 Runtime/Planner 压缩包经内部签名后组装 Desktop；本地文件清单地址
使用绝对 `file:` URL。字体及 OFL 许可、PDF 运行依赖进入资源清单。
试用包使用本地 ad-hoc 应用签名，不进行 Apple 公证或线上发布。

构建及验收目录：`.tmp/report-manual-dmg-20261010/`。
交付目录：`apps/desktop/release/report-manual-20261010/`。
源差异、文件哈希和构建标识记录在构建目录的 `build-provenance.json`。

## 验收

- DMG 挂载后校验内部签名和完整资源清单通过；挂载应用与打包应用的
  可执行文件、asar、发布描述及签名资源哈希一致。
- 打包应用在独立临时安装中新安装通过；官方账号窗口、设置和激活流程正常。
- 使用打包后的真实 Server/Web/Desktop：原始 MD 字节不变，PDF API 返回 200，
  原生保存出的 PDF 可解析出中文标题和末尾结论。
- `pi-research` 的 42235 字节手册真实激活成功，尾部限制保留。
- Finder/LaunchServices 实测从上一份同版本
  `0.1.9-internal-local20261010a` 更新至 `0.1.9-internal-local20261010b`
  成功。包含历史升级记录/残留锁场景，联合激活 committed；数据库测试记录、
  配置哈希保留，两次重启正常，关闭应用后 Server 独立存活。

DMG：`MetaWork-darwin-arm64.dmg`，488846187 字节。
SHA-256：`72ad88905f143c4955f311558a01e9767b32427fb36e43dcfcb3eb0a3341feb5`。
证据随交付目录保存在 `evidence/`，另附 `.sha256` 和内部签名 manifest。

未替换用户正式安装，未修改官方 Server，未推送或创建 GitHub Release。
Closing commit：无，用户要求保留未提交状态。
