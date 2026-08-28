/**
 * Fixed-precision decimal arithmetic (#622).
 *
 * Financial amounts must never be routed through JavaScript's floating-point
 * `number` type — one rounding disagreement can invalidate quotes, limits, or
 * contract arguments. This module provides a single canonical representation
 * of an asset amount as a scaled integer (BigInt), with rounding modes that
 * are explicitly defined and precision that is validated against the asset's
 * decimals.
 *
 * All public arithmetic (add, subtract, multiply, divide, compare) operates on
 * BigInt scaled units; the only places decimal strings enter or leave are the
 * parse/serialize boundaries.
 */

export const DECIMAL_PLACES_REGEX = /^(-)?(\d+)(?:\.(\d+))?$/;

export enum RoundingMode {
  /** Round towards zero (truncate). Never increases magnitude. */
  DOWN = "DOWN",
  /** Round away from zero. */
  UP = "UP",
  /** Round to nearest; ties away from zero. */
  HALF_UP = "HALF_UP",
  /** Round to nearest; ties towards positive infinity. */
  HALF_CEIL = "HALF_CEIL",
  /** Round to nearest; ties towards negative infinity. */
  HALF_FLOOR = "HALF_FLOOR",
}

/** Default rounding used when an operation does not specify one. */
export const DEFAULT_ROUNDING_MODE = RoundingMode.DOWN;

/** A scaled-integer decimal value. */
export interface ScaledDecimal {
  /** Signed integer scaled by 10^decimals. */
  units: bigint;
  /** Number of fractional digits this value is expressed in. */
  decimals: number;
}

const POW10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * Parse a canonical decimal string into scaled units.
 *
 * Throws if the value has more fractional digits than `decimals` (precision
 * the asset cannot represent) or if it is not a valid decimal string.
 */
export function parseScaled(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`decimals must be an integer in [0, 18], got ${decimals}`);
  }
  const match = DECIMAL_PLACES_REGEX.exec(value);
  if (!match) {
    throw new Error(`Invalid decimal amount: "${value}"`);
  }
  const [, sign, intPart, fracPart = ""] = match;
  if (fracPart.length > decimals) {
    throw new Error(
      `Amount "${value}" exceeds asset precision (max ${decimals} decimal places)`
    );
  }
  const signMul = sign === "-" ? -1n : 1n;
  const int = BigInt(intPart);
  const frac = fracPart.padEnd(decimals, "0");
  const fracUnits = frac.length > 0 ? BigInt(frac) : 0n;
  return signMul * (int * POW10(decimals) + fracUnits);
}

/** Serialize scaled units back to a canonical decimal string. */
export function serializeScaled(units: bigint, decimals: number): string {
  if (units === 0n) return "0";
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = POW10(decimals);
  const intPart = abs / scale;
  const fracPart = (abs % scale).toString().padStart(decimals, "0");
  // Trim trailing zeros in the fractional part for a canonical string.
  const trimmedFrac = fracPart.replace(/0+$/, "");
  const body = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart.toString();
  return negative ? `-${body}` : body;
}

/** Normalize two values to the same scale before comparing. */
function sameScale(a: bigint, aDecimals: number, b: bigint, bDecimals: number): [bigint, bigint] {
  if (aDecimals === bDecimals) return [a, b];
  if (aDecimals > bDecimals) {
    return [a, b * POW10(aDecimals - bDecimals)];
  }
  return [a * POW10(bDecimals - aDecimals), b];
}

/** Add two decimal values, returning a result at `resultDecimals`. */
export function addDecimals(
  a: bigint,
  aDecimals: number,
  b: bigint,
  bDecimals: number,
  resultDecimals = Math.max(aDecimals, bDecimals)
): bigint {
  const [sa, sb] = sameScale(a, aDecimals, b, bDecimals);
  const sum = sa + sb;
  return rescale(sum, Math.max(aDecimals, bDecimals), resultDecimals, DEFAULT_ROUNDING_MODE);
}

/** Subtract two decimal values, returning a result at `resultDecimals`. */
export function subtractDecimals(
  a: bigint,
  aDecimals: number,
  b: bigint,
  bDecimals: number,
  resultDecimals = Math.max(aDecimals, bDecimals)
): bigint {
  const [sa, sb] = sameScale(a, aDecimals, b, bDecimals);
  const diff = sa - sb;
  return rescale(diff, Math.max(aDecimals, bDecimals), resultDecimals, DEFAULT_ROUNDING_MODE);
}

/** Multiply two decimal values, returning a result at `resultDecimals`. */
export function multiplyDecimals(
  a: bigint,
  aDecimals: number,
  b: bigint,
  bDecimals: number,
  resultDecimals: number,
  rounding = DEFAULT_ROUNDING_MODE
): bigint {
  const product = a * b;
  return rescale(product, aDecimals + bDecimals, resultDecimals, rounding);
}

/**
 * Divide two decimal values, returning a result at `resultDecimals`.
 *
 * Division is the operation most prone to rounding disputes, so it always
 * requires an explicit rounding mode. Throws on division by zero.
 */
export function divideDecimals(
  a: bigint,
  aDecimals: number,
  b: bigint,
  bDecimals: number,
  resultDecimals: number,
  rounding: RoundingMode
): bigint {
  if (b === 0n) {
    throw new Error("Division by zero");
  }
  const [sa, sb] = sameScale(a, aDecimals, b, bDecimals);
  // Scale numerator so the quotient keeps `resultDecimals` digits.
  const scaled = sa * POW10(resultDecimals);
  const quotient = scaled / sb;
  const remainder = scaled % sb;
  return applyRounding(quotient, remainder, sb, rounding);
}

/** Apply a rounding mode to an exact division result. */
function applyRounding(
  quotient: bigint,
  remainder: bigint,
  divisor: bigint,
  rounding: RoundingMode
): bigint {
  if (remainder === 0n) return quotient;
  const negative = quotient < 0n || (quotient === 0n && remainder < 0n);
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const halfway = divisor / 2n;
  const exactlyHalf = absRemainder * 2n === divisor;

  switch (rounding) {
    case RoundingMode.DOWN:
      return quotient; // truncate towards zero
    case RoundingMode.UP:
      return negative ? quotient - 1n : quotient + 1n;
    case RoundingMode.HALF_UP:
      if (exactlyHalf) return negative ? quotient - 1n : quotient + 1n;
      return absRemainder > halfway ? (negative ? quotient - 1n : quotient + 1n) : quotient;
    case RoundingMode.HALF_CEIL:
      // Ties go towards +infinity.
      if (exactlyHalf) return quotient + 1n;
      if (negative) return absRemainder >= halfway ? quotient : quotient;
      return absRemainder > halfway ? quotient + 1n : quotient;
    case RoundingMode.HALF_FLOOR:
      // Ties go towards -infinity.
      if (exactlyHalf) return negative ? quotient - 1n : quotient;
      return negative ? (absRemainder > halfway ? quotient - 1n : quotient) : quotient;
    default:
      throw new Error(`Unknown rounding mode: ${String(rounding)}`);
  }
}

/** Rescale a value from `fromDecimals` to `toDecimals` using `rounding`. */
export function rescale(
  value: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: RoundingMode = DEFAULT_ROUNDING_MODE
): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals > toDecimals) {
    const divisor = POW10(fromDecimals - toDecimals);
    const quotient = value / divisor;
    const remainder = value % divisor;
    return applyRounding(quotient, remainder, divisor, rounding);
  }
  return value * POW10(toDecimals - fromDecimals);
}

/** Compare two decimal values. Returns -1, 0, or 1. */
export function compareDecimals(
  a: bigint,
  aDecimals: number,
  b: bigint,
  bDecimals: number
): number {
  const [sa, sb] = sameScale(a, aDecimals, b, bDecimals);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function isZeroDecimals(units: bigint): boolean {
  return units === 0n;
}
