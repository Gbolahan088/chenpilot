import { Asset, AssetAmount } from '../assets';
import { BaseEntity, Timestamp, UUID } from '../common';
import {
  addDecimals,
  multiplyDecimals,
  parseScaled,
  serializeScaled,
  subtractDecimals,
} from '../common/fixedPoint';
import { assetDecimals } from '../common/assetPrecision';

export interface BalanceProps {
  accountId: UUID;
  asset: Asset;
  amount: string;
  buyingLiabilities: string;
  sellingLiabilities: string;
  lastUpdated: Timestamp;
}

export class Balance implements BaseEntity {
  constructor(
    public readonly id: UUID,
    public readonly accountId: UUID,
    public readonly asset: Asset,
    public readonly amount: string,
    public readonly buyingLiabilities: string,
    public readonly sellingLiabilities: string,
    public readonly lastUpdated: Timestamp,
    public readonly createdAt: Timestamp,
    public readonly updatedAt: Timestamp,
    public readonly version: number
  ) {}

  /** Available = amount - buyingLiabilities - sellingLiabilities (fixed-precision). */
  get availableBalance(): string {
    const decimals = assetDecimals(this.asset);
    const amount = parseScaled(this.amount, decimals);
    const buying = parseScaled(this.buyingLiabilities, decimals);
    const selling = parseScaled(this.sellingLiabilities, decimals);
    const available = subtractDecimals(
      subtractDecimals(amount, decimals, buying, decimals, decimals),
      decimals,
      selling,
      decimals,
      decimals
    );
    return serializeScaled(available, decimals);
  }

  getAssetAmount(): AssetAmount {
    return AssetAmount.create(this.asset, this.amount);
  }

  getAvailableAssetAmount(): AssetAmount {
    return AssetAmount.create(this.asset, this.availableBalance);
  }

  canCover(amount: AssetAmount): boolean {
    if (!this.asset.equals(amount.asset)) {
      return false;
    }
    return this.getAvailableAssetAmount().isGreaterThanOrEqualTo(amount);
  }
}

export interface BalanceMap {
  [assetId: string]: Balance;
}

export class BalanceSnapshot {
  constructor(
    public readonly balances: BalanceMap,
    public readonly timestamp: Timestamp,
    public readonly blockNumber: number
  ) {}

  getBalanceForAsset(asset: Asset): Balance | undefined {
    return this.balances[asset.canonicalId];
  }

  /**
   * Total value in native units (7 decimals), computed with fixed-precision
   * multiplication and addition so no amount ever passes through `number`.
   */
  getTotalValueInNative(priceMap: Map<string, string>): string {
    const NATIVE_DECIMALS = 7;
    let total = 0n;
    for (const balance of Object.values(this.balances)) {
      const price = priceMap.get(balance.asset.canonicalId);
      if (price) {
        const assetDec = assetDecimals(balance.asset);
        // value = amount(assetDec) * price(assetDec) -> nativeDecimals
        const value = multiplyDecimals(
          parseScaled(balance.amount, assetDec),
          assetDec,
          parseScaled(price, assetDec),
          assetDec,
          NATIVE_DECIMALS
        );
        total = addDecimals(total, NATIVE_DECIMALS, value, NATIVE_DECIMALS, NATIVE_DECIMALS);
      }
    }
    return serializeScaled(total, NATIVE_DECIMALS);
  }
}
