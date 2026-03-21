import { describe, expect, it } from "vitest";
import { FieldPath, Timestamp } from "./types.js";

describe("Timestamp", () => {
  it("nowで現在時刻のTimestampを生成できる", () => {
    const before = Date.now();
    const ts = Timestamp.now();
    const after = Date.now();

    expect(ts.toMillis()).toBeGreaterThanOrEqual(before);
    expect(ts.toMillis()).toBeLessThanOrEqual(after);
  });

  it("fromDateでDateからTimestampを生成できる", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const ts = Timestamp.fromDate(date);
    expect(ts.seconds).toBe(Math.floor(date.getTime() / 1000));
    expect(ts.toDate().getTime()).toBe(date.getTime());
  });

  it("fromMillisでミリ秒からTimestampを生成できる", () => {
    const ms = 1710000000000;
    const ts = Timestamp.fromMillis(ms);
    expect(ts.seconds).toBe(1710000000);
    expect(ts.nanoseconds).toBe(0);
    expect(ts.toMillis()).toBe(ms);
  });

  it("isEqualで等値比較できる", () => {
    const ts1 = new Timestamp(100, 500);
    const ts2 = new Timestamp(100, 500);
    const ts3 = new Timestamp(100, 600);
    expect(ts1.isEqual(ts2)).toBe(true);
    expect(ts1.isEqual(ts3)).toBe(false);
  });

  it("toDateで正しいDateに変換できる", () => {
    const ts = new Timestamp(1710000000, 500_000_000);
    const date = ts.toDate();
    expect(date.getTime()).toBe(1710000000 * 1000 + 500);
  });
});

describe("FieldPath", () => {
  it("should create a FieldPath from field names", () => {
    const fp = new FieldPath("users", "name");
    expect(fp.toString()).toBe("users.name");
  });

  it("should create a single-segment FieldPath", () => {
    const fp = new FieldPath("name");
    expect(fp.toString()).toBe("name");
  });

  it("should throw on empty arguments", () => {
    expect(() => new FieldPath()).toThrow("at least one field name");
  });

  it("should throw on empty string segment", () => {
    expect(() => new FieldPath("name", "")).toThrow("non-empty strings");
  });

  it("documentId should return __name__ path", () => {
    const fp = FieldPath.documentId();
    expect(fp.toString()).toBe("__name__");
  });

  it("isEqual should compare paths", () => {
    const fp1 = new FieldPath("a", "b");
    const fp2 = new FieldPath("a", "b");
    const fp3 = new FieldPath("a", "c");
    const fp4 = new FieldPath("a");

    expect(fp1.isEqual(fp2)).toBe(true);
    expect(fp1.isEqual(fp3)).toBe(false);
    expect(fp1.isEqual(fp4)).toBe(false);
  });

  it("resolveValue should extract nested values", () => {
    const fp = new FieldPath("address", "city");
    const data = { address: { city: "Tokyo", zip: "100-0001" } };
    expect(fp.resolveValue(data)).toBe("Tokyo");
  });

  it("resolveValue should return undefined for missing paths", () => {
    const fp = new FieldPath("address", "country");
    const data = { address: { city: "Tokyo" } };
    expect(fp.resolveValue(data)).toBeUndefined();
  });

  it("resolveValue should handle top-level fields", () => {
    const fp = new FieldPath("name");
    expect(fp.resolveValue({ name: "Alice" })).toBe("Alice");
  });

  it("getSegments should return segments array", () => {
    const fp = new FieldPath("a", "b", "c");
    expect(fp.getSegments()).toEqual(["a", "b", "c"]);
  });
});
