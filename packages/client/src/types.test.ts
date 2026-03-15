import { describe, it, expect } from "vitest";
import { Timestamp } from "./types.js";

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
