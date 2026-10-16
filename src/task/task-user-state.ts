export type TaskUserState = 'waiting' | 'executing' | 'needs_action' | 'finished';

export const TASK_USER_STATE_LABELS: Readonly<Record<TaskUserState, string>> = {
  waiting: '等待中', executing: '执行中', needs_action: '需要处理', finished: '已结束',
};

