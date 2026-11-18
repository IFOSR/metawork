#!/usr/bin/env node
// local-sync 数据模式的配置快照协调器（运行在实例 Pod 内）。
//
// 背景：配置仓库用「激活日志 + 激活指针」成对表达当前激活版本
// （src/configuration/file-configuration-repository.ts）。二者必须一致：
// 日志 phase=committed 时 journal.nextRevisionId === active 指针内容。
// 逐文件拷贝会把「指针=旧、日志=新」的撕裂对拷进快照，恢复后启动即被
// RecoveryBlockedError 拦下（configuration_recovery_blocked）。
//
// 本脚本把配置目录当作一个整体快照：读日志与指针 → 复制整棵配置树 →
// 按仓库同一套规则校验副本 → 校验通过才原子发布（rename）。校验不通过就
// 丢弃本次副本、保留上一份好快照，下个周期重试。
//
// 用法：
//   node local-sync-config.mjs config-dir <dataDir>          打印配置目录（无则空行）
//   node local-sync-config.mjs snapshot  <dataDir> <snapRoot> 采集并发布配置快照
//   node local-sync-config.mjs restore   <dataDir> <snapRoot> 用快照还原配置目录
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const JOURNAL_FILE = 'activation-journal.json';
const ACTIVE_FILE = 'active';
const REVISIONS_DIR = 'revisions';
const MAX_SCAN_DEPTH = 8;

/** 找配置目录：含激活日志的目录，或含激活指针的 config 目录。 */
export function findConfigDir(dataDir) {
  const root = resolve(dataDir);
  if (!existsSync(root)) return null;
  const queue = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = entries.map(entry => entry.name);
    if (names.includes(JOURNAL_FILE)) return dir;
    if (basename(dir) === 'config' && names.includes(ACTIVE_FILE)) return dir;
    if (depth >= MAX_SCAN_DEPTH) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'revisions') {
        queue.push([join(dir, entry.name), depth + 1]);
      }
    }
  }
  return null;
}

/**
 * 读激活指针：它是**指向版本目录的符号链接**（revisions/<id>），不是普通文件。
 * 读取目标名（basename）作为当前激活版本；指针缺失/不可读时返回 null。
 */
export function readActive(configDir) {
  try {
    const link = readlinkSync(join(configDir, ACTIVE_FILE));
    return basename(link) || null;
  } catch {
    try {
      const target = statSync(join(configDir, ACTIVE_FILE));
      // 兼容早期把版本号写进普通文件的形态。
      return target.isFile() ? readFileSync(join(configDir, ACTIVE_FILE), 'utf8').trim() || null : null;
    } catch { return null; }
  }
}

function readJournal(configDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, JOURNAL_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * 与仓库 recover() 同一套判据：快照内的日志/指针组合必须能被启动恢复接受。
 * 另外校验激活版本的清单哈希——半拷贝的 revision 目录会让启动时的完整性
 * 校验失败，产出同样不可启动的快照。
 */
export function isConsistentSnapshot(configDir) {
  const active = readActive(configDir);
  const journal = readJournal(configDir);
  if (!journal) {
    // 无日志：指针指向的版本必须存在且完整（空配置允许）。
    return active ? revisionIsIntact(configDir, active) : true;
  }
  const phase = journal.phase;
  const next = typeof journal.nextRevisionId === 'string' ? journal.nextRevisionId : null;
  const previous = typeof journal.previousRevisionId === 'string' ? journal.previousRevisionId : null;
  if (phase === 'prepared') {
    if (active && active !== previous && active !== next) return false;
  } else if (phase === 'committed') {
    if (active !== next) return false;
  } else {
    return false;
  }
  return active ? revisionIsIntact(configDir, active) : true;
}

/** 激活版本的清单与文件哈希校验（与 file-configuration-repository 的 verifyRevision 同口径）。 */
export function revisionIsIntact(configDir, revisionId) {
  const revisionPath = join(configDir, REVISIONS_DIR, revisionId);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(revisionPath, 'revision-manifest.json'), 'utf8'));
  } catch { return false; }
  if (!manifest || manifest.revisionId !== revisionId || !Array.isArray(manifest.files)) return false;
  for (const entry of manifest.files) {
    let bytes;
    try { bytes = readFileSync(join(revisionPath, entry.path)); } catch { return false; }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return false;
  }
  return true;
}

/**
 * 采集配置快照：整目录复制到临时位置 → 校验副本 → 通过才原子发布。
 * 失败时保留上一份好快照（不发布），下一周期重试。
 */
export function snapshotConfig(dataDir, snapRoot) {
  const configDir = findConfigDir(dataDir);
  if (!configDir) return { status: 'no-config' };
  const target = join(resolve(snapRoot), 'config');
  const staging = `${target}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    // 复制配置树（revisions 体积小，一次性整体复制；版本内容在提交后不再变更）。
    // verbatimSymlinks：保留激活指针的相对目标（revisions/<id>）。默认行为会把
    // 目标改写成绝对路径，副本里的指针会指向快照目录而非自身。
    cpSync(configDir, staging, { recursive: true, verbatimSymlinks: true });
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return { status: 'copy-failed' };
  }
  if (!isConsistentSnapshot(staging)) {
    rmSync(staging, { recursive: true, force: true });
    return { status: 'inconsistent' };
  }
  const previous = `${target}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, previous);
  renameSync(staging, target);
  rmSync(previous, { recursive: true, force: true });
  return { status: 'published' };
}

/**
 * 用快照还原配置目录：整目录替换，保证启动看到的是校验过的日志/指针对。
 * 快照缺失时清空配置目录——应用会以 bootstrap 配置重新播种，实例仍可启动
 * （凭据在 secrets/ 下另行恢复，只有模型选择需要重选）。
 */
export function restoreConfig(dataDir, snapRoot) {
  const configDir = findConfigDir(dataDir);
  const target = join(resolve(snapRoot), 'config');
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  if (!existsSync(target)) return { status: 'no-snapshot' };
  try {
    cpSync(target, configDir ?? join(resolve(dataDir), 'config'), { recursive: true, verbatimSymlinks: true });
  } catch {
    return { status: 'restore-failed' };
  }
  return { status: 'restored' };
}

function main(argv) {
  const [command, dataDir, snapRoot] = argv.slice(2);
  if (!command || !dataDir) {
    console.error('usage: local-sync-config.mjs <config-dir|snapshot|restore> <dataDir> [snapRoot]');
    process.exit(2);
  }
  if (command === 'config-dir') {
    console.log(findConfigDir(dataDir) ?? '');
    return;
  }
  if (!snapRoot) {
    console.error('missing snapshot root');
    process.exit(2);
  }
  const result = command === 'snapshot' ? snapshotConfig(dataDir, snapRoot) : restoreConfig(dataDir, snapRoot);
  console.log(result.status);
  // 不一致只是本周期跳过：不是致命错误，下个周期重试。
  process.exit(result.status === 'inconsistent' || result.status === 'copy-failed' ? 0 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv);
}
