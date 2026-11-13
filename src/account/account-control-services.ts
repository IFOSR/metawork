/**
 * 账户级控制循环服务簇（ADR-0031 第 3、9 节）。
 *
 * 控制循环 decider 与 recovery 事实是账户作用域的 runtime-wide 服务。ADR-0055
 * D6 之后这里不再有 Kernel 决策/事件/应用账本：控制循环由 Task Runtime 拥有，
 * 被中断的操作只留下显式 recovery item。
 */

import type Database from 'better-sqlite3';
import type { ControlDecider } from '../control/control-workflow.js';
import { ControlLoopPolicy } from '../execution/control-loop-policy.js';
import { TaskRecoveryItemRepo } from '../storage/task-recovery-item-repo.js';

export interface AccountControlServices {
  readonly controlLoop: ControlDecider;
  /** Owner recovery facts for interrupted control operations. */
  readonly recoveryItems: TaskRecoveryItemRepo;
}

export function buildAccountControlServices(db: Database.Database): AccountControlServices {
  return {
    // ADR-0055 D3+D4+D5: the Task Runtime owns the whole control round; every
    // policy module sits behind this one decider.
    controlLoop: new ControlLoopPolicy(),
    recoveryItems: new TaskRecoveryItemRepo(db),
  };
}
