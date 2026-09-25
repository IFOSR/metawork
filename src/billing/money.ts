/**
 * 精确金额（ADR-0042 §6 / 实施计划 §5.2）。
 *
 * - 1 MetaCoin = 1,000,000 microCoin；1 CNY = 1,000,000,000 nanoCny。
 * - 数量乘单价保留精确有理数，直到 Query 汇总处按 half-even 只舍入一次。
 * - 跨进程大整数以十进制字符串传输，不经过浮点 number。
 */

export const MICRO_COIN_PER_META_COIN = 1_000_000n;
export const NANO_CNY_PER_CNY = 1_000_000_000n;
export const BASIS_POINTS_DENOMINATOR = 10_000n;
export const MIN_MARKUP_BPS = 3_000n;
export const MAX_MARKUP_BPS = 5_000n;

/** nanoCny -> microCoin 且应用 bps 加价时的固定分母：1000 × 10000。 */
const ASSESS_DENOMINATOR = 10_000_000n;

export function roundHalfEven(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('invalid_amount');
  const q = n / d;
  const r = n % d;
  return q + (r * 2n > d || (r * 2n === d && q % 2n !== 0n) ? 1n : 0n);
}

/**
 * 把已精确表示为整数 nanoCny 的可收费基数按加价率换算为 microCoin。
 * 一般有理数路径请先归一到 nanoCny（见 `rationalToNanoCny`）。
 */
export function assessMicroCoin(costNanoCny: bigint, markupBps: bigint): bigint {
  if (markupBps < MIN_MARKUP_BPS || markupBps > MAX_MARKUP_BPS) {
    throw new Error('invalid_markup');
  }
  if (costNanoCny < 0n) throw new Error('invalid_amount');
  return roundHalfEven(costNanoCny * (BASIS_POINTS_DENOMINATOR + markupBps), ASSESS_DENOMINATOR);
}

/**
 * 精确有理数路径的应计换算：先把精确有理数 cost 乘以加价率，再一次
 * half-even 舍入为整数 microCoin，绝不提前截断 sub-nanoCny 分数。
 */
export function assessRationalMicroCoin(costNanoCny: Rational, markupBps: bigint): bigint {
  if (markupBps < MIN_MARKUP_BPS || markupBps > MAX_MARKUP_BPS) {
    throw new Error('invalid_markup');
  }
  if (costNanoCny.numerator < 0n) throw new Error('invalid_amount');
  return roundHalfEven(
    costNanoCny.numerator * (BASIS_POINTS_DENOMINATOR + markupBps),
    costNanoCny.denominator * ASSESS_DENOMINATOR,
  );
}

/** 精确有理数；分母恒为正，约分到最简。零表示为 0/1。 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) throw new Error('invalid_amount');
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n < 0n ? -n : n, d);
  return Object.freeze({ numerator: n / divisor, denominator: d / divisor });
}

export const ZERO_RATIONAL: Rational = rational(0n);

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function isZeroRational(value: Rational): boolean {
  return value.numerator === 0n;
}

export function isNegativeRational(value: Rational): boolean {
  return value.numerator < 0n;
}

export function compareRational(left: Rational, right: Rational): number {
  const diff = left.numerator * right.denominator - right.numerator * left.denominator;
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/** 向下取整到整数单位；非负有理数专用。 */
export function floorRational(value: Rational): bigint {
  if (value.numerator < 0n) throw new Error('invalid_amount');
  return value.numerator / value.denominator;
}

/** half-even 舍入到整数单位；非负有理数专用。 */
export function roundRationalHalfEven(value: Rational): bigint {
  if (value.numerator < 0n) throw new Error('invalid_amount');
  return roundHalfEven(value.numerator, value.denominator);
}

/**
 * 把精确有理数金额归一到整数 nanoCny。
 * 分数精度不足以整数表达时拒绝，而不是静默截断（ADR-0042 §6）。
 */
export function rationalToNanoCny(value: Rational): bigint {
  if (value.numerator % value.denominator !== 0n) {
    throw new Error('amount_precision_below_nanocny');
  }
  return value.numerator / value.denominator;
}

export function nanoCnyToRational(value: bigint): Rational {
  return rational(value);
}

/**
 * 解析十进制金额字符串为整数最小单位。`decimals` 是单位刻度
 * （microCoin=6、nanoCny=9）。超出刻度的小数位会被拒绝，不做静默舍入。
 */
export function parseDecimalUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid_scale');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text.trim());
  if (!match) throw new Error('invalid_decimal_amount');
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > decimals) throw new Error('amount_precision_exceeded');
  const padded = fraction.padEnd(decimals, '0');
  const magnitude = BigInt(`${whole}${padded}`);
  return sign === '-' ? -magnitude : magnitude;
}

/** 把整数最小单位格式化为规范十进制字符串，去除无意义的尾随零。 */
export function formatDecimalUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid_scale');
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/u, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

export interface WeightedShare {
  readonly id: string;
  readonly weight: Rational;
}

export interface DistributedShare {
  readonly id: string;
  readonly amount: bigint;
}

/**
 * 确定性最大余数法分配（ADR-0042 §6）：明细之和恒等于 total，
 * 不逐行重新加价舍入。权重必须非负且至少一个为正。
 */
export function distributeByWeights(
  total: bigint,
  shares: readonly WeightedShare[],
): DistributedShare[] {
  if (total < 0n) throw new Error('invalid_amount');
  if (shares.length === 0) {
    if (total !== 0n) throw new Error('distribution_without_weights');
    return [];
  }
  const ordered = [...shares].sort((left, right) => left.id.localeCompare(right.id));
  const weightTotal = ordered.reduce(
    (sum, share) => addRational(sum, share.weight),
    ZERO_RATIONAL,
  );
  if (isZeroRational(weightTotal)) {
    if (total !== 0n) throw new Error('distribution_without_weights');
    return ordered.map(share => ({ id: share.id, amount: 0n }));
  }
  let assigned = 0n;
  const rows = ordered.map(share => {
    const exact = multiplyRational(rational(total), rational(
      share.weight.numerator,
      share.weight.denominator,
    ));
    const scaled = rational(
      exact.numerator * weightTotal.denominator,
      exact.denominator * weightTotal.numerator,
    );
    const base = floorRational(scaled);
    assigned += base;
    return {
      id: share.id,
      base,
      remainder: subtractRational(scaled, rational(base)),
    };
  });
  let leftover = total - assigned;
  const byRemainder = [...rows].sort((left, right) => (
    compareRational(right.remainder, left.remainder) || left.id.localeCompare(right.id)
  ));
  for (const row of byRemainder) {
    if (leftover <= 0n) break;
    row.base += 1n;
    leftover -= 1n;
  }
  return rows.map(row => ({ id: row.id, amount: row.base }));
}
