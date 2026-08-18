/**
 * 账户级 Kernel 服务簇（ADR-0031 第 3、9 节）。
 *
 * ControlKernel、KernelDecisionRepo、KernelWorkflowRepo 是账户作用域的
 * runtime-wide 服务，按账户（独立数据库）构造一次。Conversation/Session
 * 不得各自构造一套；它们通过 AccountRuntime 共享这些服务。
 */

import type Database from 'better-sqlite3';
import { ControlKernel } from '../kernel/control-kernel.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';

export interface AccountKernelServices {
  readonly controlKernel: ControlKernel;
  readonly kernelDecisionRepo: KernelDecisionRepo;
  readonly kernelWorkflowRepo: KernelWorkflowRepo;
}

export function buildAccountKernelServices(db: Database.Database): AccountKernelServices {
  return {
    controlKernel: new ControlKernel(),
    kernelDecisionRepo: new KernelDecisionRepo(db),
    kernelWorkflowRepo: new KernelWorkflowRepo(db),
  };
}
