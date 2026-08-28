import fc from "fast-check";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  isZeroDecimals,
  multiplyDecimals,
  parseScaled,
  rescale,
  RoundingMode,
  serializeScaled,
  subtractDecimals,
} from "../common/fixedPoint";

const DECIMALS = 7;
const MAX_INT_DIGITS = 20;

/** Generate a valid non-negative decimal string at `decimals` places. */
const amountArbitrary = (decimals: number) =>
  fc
    .record({
      int: fc.integer({ min: 0, max: 10 ** 12 - 1 }),
      frac: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: decimals }),
    })
    .map(({ int, frac }) => {
      const fracStr = frac.join("").padEnd(0);
      return frac.length === 0 ? String(int) : `${int}.${fracStr}`;
    });

const scaledArbitrary = (decimals: number) =>
  fc.bigInt({ min: -(10n ** BigInt(MAX_INT_DIGITS)), max: 10n ** BigInt(MAX_INT_DIGITS) });

describe("fixedPoint", () => {
  describe("parse/serialize round-trip", () => {
    it("is canonical (no trailing zeros) and stable", () => {
      fc.assert(
        fc.property(amountArbitrary(DECIMALS), (s) => {
          const units = parseScaled(s, DECIMALS);
          const out = serializeScaled(units, DECIMALS);
          // Re-parsing the serialized form yields identical units.
          expect(parseScaled(out, DECIMALS)).toBe(units);
          // Serialized form has no trailing fractional zeros.
          if (out.includes(".")) {
            expect(out).not.toMatch(/0+$/);
          }
        })
      );
    });

    it("handles zero and signs", () => {
      expect(serializeScaled(0n, DECIMALS)).toBe("0");
      expect(parseScaled("0", DECIMALS)).toBe(0n);
      expect(parseScaled("-0.5", DECIMALS)).toBe(-5_000_000n);
      expect(serializeScaled(-5_000_000n, DECIMALS)).toBe("-0.5");
    });

    it("rejects precision an asset cannot represent", () => {
      expect(() => parseScaled("0.12345678", 7)).toThrow(/exceeds asset precision/);
      expect(() => parseScaled("1.00000001", 7)).toThrow(/exceeds asset precision/);
      // Exactly 7 fractional digits is fine.
      expect(parseScaled("0.1234567", 7)).toBe(1_234_567n);
    });
  });

  describe("addition / subtraction", () => {
    it("is exact for large magnitudes (no float overflow)", () => {
      const a = parseScaled("999999999999.9999999", 7);
      const b = parseScaled("0.0000001", 7);
      const sum = addDecimals(a, 7, b, 7, 7);
      expect(sum).toBe(parseScaled("1000000000000.0000000", 7));
      expect(serializeScaled(sum, 7)).toBe("1000000000000");
    });

    it("is exact for small dust (no underflow)", () => {
      const a = parseScaled("0.0000001", 7);
      const b = parseScaled("0.0000002", 7);
      expect(addDecimals(a, 7, b, 7, 7)).toBe(parseScaled("0.0000003", 7));
    });

    it("a + b - b === a (property)", () => {
      fc.assert(
        fc.property(scaledArbitrary(7), scaledArbitrary(7), (a, b) => {
          const sum = addDecimals(a, 7, b, 7, 7);
          const back = subtractDecimals(sum, 7, b, 7, 7);
          expect(back).toBe(a);
        })
      );
    });

    it("is commutative", () => {
      fc.assert(
        fc.property(scaledArbitrary(7), scaledArbitrary(7), (a, b) => {
          expect(addDecimals(a, 7, b, 7, 7)).toBe(addDecimals(b, 7, a, 7, 7));
        })
      );
    });
  });

  describe("multiplication", () => {
    it("is exact at the requested result decimals", () => {
      // 2.5 * 0.4 = 1.0
      const product = multiplyDecimals(
        parseScaled("2.5", 1),
        1,
        parseScaled("0.4", 1),
        1,
        1,
        RoundingMode.DOWN
      );
      expect(product).toBe(parseScaled("1.0", 1));
    });

    it("rounds boundary values per mode", () => {
      // 0.005 at 3 decimals -> 2 decimals: HALF_UP rounds to 0.01
      const a = parseScaled("0.005", 3);
      const product = multiplyDecimals(a, 3, 1n, 0, 2, RoundingMode.HALF_UP);
      expect(product).toBe(parseScaled("0.01", 2));
      // DOWN truncates to 0.00
      const down = multiplyDecimals(a, 3, 1n, 0, 2, RoundingMode.DOWN);
      expect(down).toBe(0n);
    });
  });

  describe("division", () => {
    it("requires an explicit rounding mode", () => {
      // 1 / 3 at 7 decimals
      const quotient = divideDecimals(
        parseScaled("1", 0),
        0,
        parseScaled("3", 0),
        0,
        7,
        RoundingMode.HALF_UP
      );
      expect(quotient).toBe(parseScaled("0.3333333", 7));
    });

    it("rejects division by zero", () => {
      expect(() =>
        divideDecimals(1n, 0, 0n, 0, 7, RoundingMode.DOWN)
      ).toThrow(/Division by zero/);
    });

    it("a / b * b approx a (property)", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 1n, max: 10n ** 15n }),
          fc.bigInt({ min: 1n, max: 10n ** 15n }),
          (a, b) => {
            const q = divideDecimals(a, 7, b, 7, 7, RoundingMode.HALF_UP);
            const back = multiplyDecimals(q, 7, b, 7, 7, RoundingMode.HALF_UP);
            const diff = back - a;
            const tolerance = b / 2n + 1n; // rounding of q to 7dp scales by b
            expect(diff <= tolerance && diff >= -tolerance).toBe(true);
          }
        )
      );
    });
  });

  describe("comparison", () => {
    it("orders across scales", () => {
      expect(compareDecimals(parseScaled("1.0", 1), 1, parseScaled("0.999", 3), 3)).toBe(1);
      expect(compareDecimals(parseScaled("1.0", 1), 1, parseScaled("1.000", 3), 3)).toBe(0);
      expect(compareDecimals(parseScaled("0.99", 2), 2, parseScaled("1", 0), 0)).toBe(-1);
    });

    it("isZero", () => {
      expect(isZeroDecimals(0n)).toBe(true);
      expect(isZeroDecimals(parseScaled("0.0000000", 7))).toBe(true);
      expect(isZeroDecimals(parseScaled("0.0000001", 7))).toBe(false);
    });
  });

  describe("rescale", () => {
    it("rounds down by default and half-up when asked", () => {
      const value = parseScaled("0.005", 3);
      expect(rescale(value, 3, 2, RoundingMode.DOWN)).toBe(0n);
      expect(rescale(value, 3, 2, RoundingMode.HALF_UP)).toBe(parseScaled("0.01", 2));
    });

    it("scales up exactly", () => {
      expect(rescale(1n, 0, 2, RoundingMode.DOWN)).toBe(100n);
    });
  });
});
