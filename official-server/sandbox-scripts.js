// local-sync 数据模式的 Pod 内脚本（由 official-server 渲染进 Deployment 模板）。
// 路径经 SANDBOX_DATA_DIR / SANDBOX_SYNC_ROOT 覆盖仅供测试注入；生产容器不设
// 这两个变量，缺省即 /data 与 /sync。设计记录：
// docs/plans/2026-11-18-runtime-local-data-nas-sync.md。

const dataDir = () => process.env.SANDBOX_DATA_DIR ?? '/data';
const syncRoot = () => process.env.SANDBOX_SYNC_ROOT ?? '/sync';

/**
 * 一次同步（SQLite 一致性快照 → git 镜像 → 其余文件增量）。
 * 单步失败只影响该项不中断流程；SQLite 用 TRUNCATE checkpoint + 只拷主文件
 * （node:sqlite 22.x 没有 backup() API，拷活库/wal 会得到不一致副本）。
 * name：实例资源名（mw-rt-<id>，无下划线），同步子目录与之一致。
 */
export function sandboxSyncOnceScript(name) {
  const data = dataDir();
  return `
DATA=${data}
D=${syncRoot()}/${name}
mkdir -p "$D/db" "$D/git" "$D/rest"
find "$DATA" -type f \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \\) ! -name '*-wal' ! -name '*-shm' 2>/dev/null | while read -r f; do
  rel=\${f#"$DATA"/}; d="$D/db/\$(dirname "$rel")"; mkdir -p "$d"
  # node:sqlite（22.x）没有 backup()：先 TRUNCATE checkpoint 把 WAL 并入主文件，
  # 再只拷主文件——快照 = checkpoint 时刻的完整一致状态，之后的写入在新 -wal 里
  # 不污染拷贝。checkpoint 失败（写冲突）跳过本轮，下轮重试。
  node -e 'const{DatabaseSync}=require("node:sqlite");try{const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA busy_timeout=2000");db.exec("PRAGMA wal_checkpoint(TRUNCATE)");db.close()}catch(e){process.exit(1)}' "$f" && cp -p "$f" "$d/\$(basename "$f").tmp" && mv -f "$d/\$(basename "$f").tmp" "$d/\$(basename "$f")"
done
find "$DATA" -maxdepth 4 -type d -name .git 2>/dev/null | while read -r g; do
  w=$(dirname "$g"); n=$(echo "$w" | tr '/' '_')
  [ -d "$D/git/$n.git" ] || git init -q --bare "$D/git/$n.git"
  git -C "$w" push -q --mirror "$D/git/$n.git" 2>/dev/null || true
done
STAMP=$D/rest/.stamp
NEWER=""
[ -f "$STAMP" ] && NEWER="-newer $STAMP"
# 戳取扫描开始时刻而非结束：扫描期间在写的文件 mtime 仍大于新戳，下轮必然重扫。
NOW=$(date +%s)
find "$DATA" -type f $NEWER ! -name '*-wal' ! -name '*-shm' ! -name '*.db' ! -name '*.sqlite*' 2>/dev/null | while read -r f; do
  rel=\${f#"$DATA"/}; d=$D/rest/$(dirname "$rel"); mkdir -p "$d"
  cp -p "$f" "$D/rest/$rel" 2>/dev/null || true
done
touch -d "@$NOW" "$STAMP"
`;
}

/**
 * 新 Pod 冷启动恢复：本地目录为空且 NAS 有快照时先恢复数据。
 * db/ 最后覆盖（checkpoint 后的主文件自含完整状态）；清掉恢复出来的遗留
 * -wal/-shm，它们属于旧的不一致状态，与快照主库不匹配。本地非空（容器崩溃
 * 后重启，emptyDir 随 Pod 保留）时不动本地数据，服务继续用本地现态。
 */
export function sandboxRestoreScript(name) {
  const data = dataDir();
  return `
DATA=${data}
D=${syncRoot()}/${name}
if [ -z "$(ls -A "$DATA" 2>/dev/null)" ]; then
  if [ -d "$D/rest" ]; then cp -a "$D/rest/." "$DATA/" 2>/dev/null || true; fi
  if [ -d "$D/db" ]; then cp -a "$D/db/." "$DATA/" 2>/dev/null || true; fi
  find "$DATA" \\( -name '*-wal' -o -name '*-shm' \\) -delete 2>/dev/null
fi
`;
}
