import { ValueObject, validatePositive, validateNonNegative } from '../common';
import { Asset } from './asset';
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  isZeroDecimals,
  multiplyDecimals,
  parseScaled,
  RoundingMode,
  serializeScaled,
  subtractDecimals,
} from '../common/fixedPoint';
import { assetDecimals, assetRounding } from '../common/assetPrecision';

export interface AssetAmountProps {
  asset: Asset;
  amount: string;
}

/**
 * Canonical fixed-precision asset amount (#622).
 *
 * Internally stores the amount as scaled BigInt units (10^decimals) so that no
 * execution path converts the amount through JavaScript's floating-point
 * `number`. All arithmetic uses fixed-precision operations with centrally
 * defined rounding (see `assetPrecision`). Serialization is canonical: trailing
 * fractional zeros are trimmed.
 */
export class AssetAmount extends ValueObject<AssetAmountProps> {
  private constructor(props: AssetAmountProps) {
    super(props);
  }

  static create(asset: Asset, amount: string): AssetAmount {
    validateNonNegative(amount, 'amount');
    // Reject precision the asset cannot represent before storing anything.
    const decimals = assetDecimals(asset);
    parseScaled(amount, decimals);
    return new AssetAmount({ asset, amount });
  }

  static createPositive(asset: Asset, amount: string): AssetAmount {
    validatePositive(amount, 'amount');
    const decimals = assetDecimals(asset);
    parseScaled(amount, decimals);
    return new AssetAmount({ asset, amount });
  }

  get asset(): Asset {
    return this._value.asset;
  }

  get amount(): string {
    return this._value.amount;
  }

  /** Scaled integer units at the asset's decimals. */
  toUnits(): bigint {
    return parseScaled(this.amount, assetDecimals(this.asset));
  }

  add(other: AssetAmount): AssetAmount {
    if (!this.asset.equals(other.asset)) {
      throw new Error('Cannot add different assets');
    }
    const decimals = assetDecimals(this.asset);
    const sum = addDecimals(
      this.toUnits(),
      decimals,
      other.toUnits(),
      assetDecimals(other.asset),
      decimals
    );
    return AssetAmount.create(this.asset, serializeScaled(sum, decimals));
  }

  subtract(other: AssetAmount): AssetAmount {
    if (!this.asset.equals(other.asset)) {
      throw new Error('Cannot subtract different assets');
    }
    const decimals = assetDecimals(this.asset);
    const diff = subtractDecimals(
      this.toUnits(),
      decimals,
      other.toUnits(),
      assetDecimals(other.asset),
      decimals
    );
    return AssetAmount.create(this.asset, serializeScaled(diff, decimals));
  }

  multiplyBy(rate: string, rateDecimals: number, rounding = assetRounding()): AssetAmount {
    const decimals = assetDecimals(this.asset);
    const product = multiplyDecimals(
      this.toUnits(),
      decimals,
      parseScaled(rate, rateDecimals),
      rateDecimals,
      decimals,
      rounding
    );
    return AssetAmount.create(this.asset, serializeScaled(product, decimals));
  }

  divideBy(
    divisor: string,
    divisorDecimals: number,
    resultDecimals: number = assetDecimals(this.asset),
    rounding: RoundingMode = assetRounding()
  ): AssetAmount {
    const decimals = assetDecimals(this.asset);
    const quotient = divideDecimals(
      this.toUnits(),
      decimals,
      parseScaled(divisor, divisorDecimals),
      divisorDecimals,
      resultDecimals,
      rounding
    );
    return AssetAmount.create(this.asset, serializeScaled(quotient, resultDecimals));
  }

  isZero(): boolean {
    return isZeroDecimals(this.toUnits());
  }

  isGreaterThan(other: AssetAmount): boolean {
    if (!this.asset.equals(other.asset)) {
      throw new Error('Cannot compare different assets');
    }
    return (
      compareDecimals(
        this.toUnits(),
        assetDecimals(this.asset),
        other.toUnits(),
        assetDecimals(other.asset)
      ) > 0
    );
  }

  isGreaterThanOrEqualTo(other: AssetAmount): boolean {
    if (!this.asset.equals(other.asset)) {
      throw new Error('Cannot compare different assets');
    }
    return (
      compareDecimals(
        this.toUnits(),
        assetDecimals(this.asset),
        other.toUnits(),
        assetDecimals(other.asset)
      ) >= 0
    );
  }

  toString(): string {
    return `${this.amount} ${this.asset.code}`;
  }
}
