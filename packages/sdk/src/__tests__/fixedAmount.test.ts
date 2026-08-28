import fc from "fast-check";
import { parseScaledAmount, serializeScaledAmount, sumAmounts } from "../fixedAmount";

describe("SDK fixedAmount (#622)", () => {
  describe("parse/serialize round-trip", () => {
    it("is canonical and stable", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 10 ** 9 }), (n) => {
          const units = parseScaledAmount(String(n), 7);
          expect(serializeScaledAmount(units, 7)).toBe(String(n));
        })
      );
    });

    it("handles fractional values exactly", () => {
      expect(parseScaledAmount("0.1", 7)).toBe(1_000_000n);
      expect(parseScaledAmount("0.2", 7)).toBe(2_000_000n);
      expect(serializeScaledAmount(3_000_000n, 7)).toBe("0.3");
    });

    it("rejects precision beyond the asset", () => {
      expect(() => parseScaledAmount("0.00000001", 7)).toThrow(/exceeds precision/);
    });
  });

  describe("sumAmounts", () => {
    it("sums 0.1 + 0.2 without float drift", () => {
      expect(sumAmounts(["0.1", "0.2"], 7)).toBe("0.3");
    });

    it("handles dust and large values", () => {
      expect(sumAmounts(["0.0000001", "0.0000002"], 7)).toBe("0.0000003");
      expect(sumAmounts(["999999999.9999999", "0.0000001"], 7)).toBe("1000000000");
    });

    it("is exact for many terms (no float accumulation error)", () => {
      const terms = Array.from({ length: 1000 }, () => "0.0000001");
      expect(sumAmounts(terms, 7)).toBe("0.0001");
    });
  });
});
