import { describe, expect, it } from "vitest";
import { nowIsoMicros } from "./time.js";

describe("nowIsoMicros", () => {
  it("マイクロ秒精度（小数6桁）の ISO 8601 文字列を返す", () => {
    const iso = nowIsoMicros();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("現在時刻と一致する（±5秒）", () => {
    const iso = nowIsoMicros();
    const parsed = new Date(iso).getTime();
    expect(Math.abs(parsed - Date.now())).toBeLessThan(5000);
  });

  it("単調に増加する（連続呼び出しで逆行しない）", () => {
    const a = nowIsoMicros();
    const b = nowIsoMicros();
    expect(b >= a).toBe(true);
  });
});
