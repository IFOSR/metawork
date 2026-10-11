// Maps technical attempt failure details to actionable user-facing hints.
// Used by executor attempt settlement summaries so Feishu/TUI/Web surfaces
// explain what went wrong and what to do next instead of surfacing raw errno
// strings.
export function describeAttemptFailure(input: {
  failureCode?: string | null;
  errorDetail?: string | null;
}): string | null {
  const detail = input.errorDetail ?? '';
  if (detail.includes('cannot copy a socket file')) {
    return '执行环境里残留了守护进程的 socket 文件，复制工作区时被中断；已在新版本中自动跳过此类文件，请重试任务。';
  }
  if (detail.includes('rejects symlink')) {
    return '工作区包含符号链接（如 Python 虚拟环境），快照校验被拒绝；已在新版本中自动跳过此类文件，请重试任务。';
  }
  if (detail.includes('ENOTEMPTY') && detail.includes('rmdir')) {
    return '工作区清理时遇到文件系统时序问题；已在新版本中增加重试，请重试任务。';
  }
  if (detail.includes('subdirectory of self') || detail.includes('into itself')) {
    return 'Workspace 包含 MetaWork 运行目录，系统在 Executor 启动前停止了任务；请选择具体项目目录后重新提交。';
  }
  if (detail.includes('has no workspace source')) {
    return '任务没有有效 Workspace 绑定，Executor 尚未启动；请选择具体项目目录后重新提交。';
  }
  if (input.failureCode === 'attempt_timeout' || detail.includes('timeout')) {
    return '执行超时；可在配置中调大 attempt 超时后重试。';
  }
  if (input.failureCode === 'upstream_stream_interrupted' || /response stream (?:was )?interrupted/i.test(detail)) {
    return '上游模型响应流在 Executor 已启动后中断，未产生可用结果；系统会按恢复策略重试。若仍失败，请检查网络、Provider 服务状态和模型额度。';
  }
  if (detail.includes('401') || detail.includes('Unauthorized')) {
    return '模型服务拒绝了 API Key；请检查 Provider 密钥是否有效。';
  }
  if (detail.includes('429')) {
    return '模型服务限流；稍后重试或更换模型。';
  }
  return null;
}
