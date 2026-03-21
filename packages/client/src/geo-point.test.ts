import { describe, expect, it } from "vitest";
import { GeoPoint } from "./geo-point.js";

describe("GeoPoint", () => {
  it("正しい座標で作成できる", () => {
    const point = new GeoPoint(35.6762, 139.6503);
    expect(point.latitude).toBe(35.6762);
    expect(point.longitude).toBe(139.6503);
  });

  it("緯度が範囲外の場合エラーになる", () => {
    expect(() => new GeoPoint(91, 0)).toThrow("Latitude must be in the range of [-90, 90]");
    expect(() => new GeoPoint(-91, 0)).toThrow("Latitude must be in the range of [-90, 90]");
  });

  it("経度が範囲外の場合エラーになる", () => {
    expect(() => new GeoPoint(0, 181)).toThrow("Longitude must be in the range of [-180, 180]");
    expect(() => new GeoPoint(0, -181)).toThrow("Longitude must be in the range of [-180, 180]");
  });

  it("境界値で作成できる", () => {
    expect(() => new GeoPoint(90, 180)).not.toThrow();
    expect(() => new GeoPoint(-90, -180)).not.toThrow();
  });

  it("isEqualで比較できる", () => {
    const a = new GeoPoint(35.6762, 139.6503);
    const b = new GeoPoint(35.6762, 139.6503);
    const c = new GeoPoint(34.0, 135.0);

    expect(a.isEqual(b)).toBe(true);
    expect(a.isEqual(c)).toBe(false);
  });

  it("シリアライズ/デシリアライズが往復できる", () => {
    const original = new GeoPoint(35.6762, 139.6503);
    const serialized = original.toSerialized();

    expect(serialized).toEqual({
      __type: "geopoint",
      value: { latitude: 35.6762, longitude: 139.6503 },
    });

    const restored = GeoPoint.fromSerialized(serialized.value);
    expect(original.isEqual(restored)).toBe(true);
  });
});
