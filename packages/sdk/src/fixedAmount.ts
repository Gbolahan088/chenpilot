/**
 * SDK fixed-precision decimal helpers (#622).
 *
 * A self-contained BigInt-backed decimal used wherever the SDK touches asset
 * amounts. Kept local so the SDK does not depend on backend-only modules while
 * preserving the same canonical semantics (scaled integers, no `number`).
 */

const DECIMAL_REGEX = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string into scaled integer units at `decimals` places. */
export function parseScaledAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`decimals must be an integer in [0, 18], got ${decimals}`);
  }
  const m = DECIMAL_REGEX.exec(value);
  if (!m) throw new Error(`Invalid decimal amount: "${value}"`);
  const [, sign, int, frac = ""] = m;
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${value}" exceeds precision (max ${decimals} decimal places)`
    );
  }
  const mul = sign === "-" ? -1n : 1n;
  const scaled = BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return mul * scaled;
}

/** Serialize scaled units to a canonical decimal string. */
export function serializeScaledAmount(units: bigint, decimals: number): string {
  if (units === 0n) return "0";
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const intPart = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac ? `${intPart}.${frac}` : intPart.toString();
  return negative ? `-${body}` : body;
}

/**
 * Sum decimal strings at `decimals` places and return a canonical string.
 * All arithmetic is integer-based; nothing passes through `number`.
 */
export function sumAmounts(values: string[], decimals: number): string {
  let total = 0n;
  for (const v of values) {
    total += parseScaledAmount(v, decimals);
  }
  return serializeScaledAmount(total, decimals);
}
