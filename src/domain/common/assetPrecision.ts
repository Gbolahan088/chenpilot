import { RoundingMode } from "./fixedPoint";
import type { Asset } from "../assets/asset";

/**
 * Central asset precision and rounding rules (#622).
 *
 * Every asset amount that crosses an API, domain, persistence, or adapter
 * boundary must be rounded according to the rules defined here — never by an
 * ad-hoc `Math.round`/`parseFloat` at the call site. This keeps serialization
 * canonical and stable across the SDK and backend.
 */

/** Fallback decimals when an asset has not been assigned an explicit value. */
export const DEFAULT_ASSET_DECIMALS = 7;

/**
 * Well-known asset decimals. Stellar native (XLM) and most issued assets use
 * 7 decimals (Stellar's default), but issued assets may declare otherwise.
 * `Asset.decimals` always wins; this registry only supplies a stable default
 * for assets constructed without explicit decimals.
 */
const ASSET_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 7,
  EURC: 7,
  BRL: 7,
  ARS: 7,
  NGN: 2,
  USD: 2,
};

/** Default rounding for asset-amount arithmetic. */
export const DEFAULT_ASSET_ROUNDING = RoundingMode.DOWN;

/**
 * The number of decimal places an asset can represent.
 * Rejects precision an asset cannot represent (see `parseScaled`).
 */
export function assetDecimals(asset: Asset): number {
  if (Number.isInteger(asset.decimals) && asset.decimals >= 0) {
    return asset.decimals;
  }
  return ASSET_DECIMALS[asset.code] ?? DEFAULT_ASSET_DECIMALS;
}

/** Central rounding rule for asset amounts. */
export function assetRounding(): RoundingMode {
  return DEFAULT_ASSET_ROUNDING;
}
