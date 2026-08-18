/**
 * Account identity 与校验。
 *
 * 账户 ID 是账户级数据隔离的根命名空间。校验必须拒绝路径穿越与空标识符，
 * 防止账户根目录逃逸（ADR-0031 第 9 节：账户数据物理隔离）。
 *
 * 纯函数模块：不 import 任何 repository / socket / http / planner / kernel /
 * executor。
 */

export const LOCAL_DEFAULT_ACCOUNT_ID = 'local-default';

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ACCOUNT_ID_MAX_LENGTH = 64;

export function isValidAccountId(value: string): boolean {
  return value.length > 0
    && value.length <= ACCOUNT_ID_MAX_LENGTH
    && ACCOUNT_ID_PATTERN.test(value);
}

export function parseAccountId(value: string): string | null {
  return isValidAccountId(value) ? value : null;
}
