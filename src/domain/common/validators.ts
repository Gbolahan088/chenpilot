import { ValidationError } from './errors';
import { parseScaled } from './fixedPoint';

const DECIMAL_STRING_REGEX = /^-?\d+(?:\.\d+)?$/;

/** Validate that `value` is a syntactically valid fixed-precision decimal. */
const assertDecimalString = (value: string, fieldName: string): void => {
  if (!DECIMAL_STRING_REGEX.test(value)) {
    throw new ValidationError(`${fieldName} must be a valid decimal string, got ${value}`);
  }
};

/** True when a decimal string is negative (sign-aware, no float coercion). */
const isNegativeDecimal = (value: string): boolean => value.startsWith('-');

export const validateNonNegative = (value: string, fieldName: string): void => {
  assertDecimalString(value, fieldName);
  if (isNegativeDecimal(value)) {
    throw new ValidationError(`${fieldName} cannot be negative, got ${value}`);
  }
};

export const validatePositive = (value: string, fieldName: string): void => {
  assertDecimalString(value, fieldName);
  if (isNegativeDecimal(value)) {
    throw new ValidationError(`${fieldName} must be positive, got ${value}`);
  }
  // Zero check without floating point: every digit is '0'.
  const isZero =
    value.replace('.', '').split('').every((ch) => ch === '0');
  if (isZero) {
    throw new ValidationError(`${fieldName} must be positive, got ${value}`);
  }
};

/**
 * Validate that a decimal string is non-negative AND fits the asset's
 * precision (i.e. has no more than `decimals` fractional digits).
 */
export const validateNonNegativeAmount = (value: string, decimals: number): void => {
  validateNonNegative(value, 'amount');
  parseScaled(value, decimals); // throws on excess precision
};

export const validateAddress = (address: string): void => {
  // Stellar address format validation
  const stellarAddressRegex = /^G[A-Z0-9]{55}$/;
  if (!stellarAddressRegex.test(address)) {
    throw new ValidationError(`Invalid Stellar address: ${address}`);
  }
};

export const validateAssetCode = (code: string): void => {
  if (!code || code.length < 1 || code.length > 12) {
    throw new ValidationError(`Asset code must be 1-12 characters, got ${code}`);
  }
  if (!/^[A-Za-z0-9]+$/.test(code)) {
    throw new ValidationError(`Asset code must be alphanumeric, got ${code}`);
  }
};
