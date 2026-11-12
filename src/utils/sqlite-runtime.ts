/** better-sqlite3 ships one prebuilt binary per Node ABI; running under a
 *  different Node major fails at import with a cryptic ERR_DLOPEN_FAILED.
 *  Surface an actionable message before any command touches the database. */
export async function assertSqliteLoadable(): Promise<void> {
  try {
    await import('better-sqlite3');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_DLOPEN_FAILED') {
      throw new Error(
        `better-sqlite3 原生模块与当前 Node ${process.version}（ABI ${process.versions.modules}）不兼容。`
        + ' 请使用 Node 22.19+ 运行 MetaWork，或在本安装执行 `npm rebuild better-sqlite3` 后重试。',
      );
    }
    throw error;
  }
}
