import { describe, expect, it } from "vitest";
import { VectorValue, vector } from "./vector.js";

describe("VectorValue", () => {
  it("fromArrayでベクトルを作成できる", () => {
    const v = VectorValue.fromArray([1.0, 2.0, 3.0]);
    expect(v.toArray()).toEqual([1.0, 2.0, 3.0]);
    expect(v.dimensions).toBe(3);
  });

  it("vectorヘルパーで作成できる", () => {
    const v = vector([4.0, 5.0]);
    expect(v.dimensions).toBe(2);
    expect(v.toArray()).toEqual([4.0, 5.0]);
  });

  it("isEqualで等値比較できる", () => {
    const v1 = vector([1, 2, 3]);
    const v2 = vector([1, 2, 3]);
    const v3 = vector([1, 2, 4]);
    const v4 = vector([1, 2]);

    expect(v1.isEqual(v2)).toBe(true);
    expect(v1.isEqual(v3)).toBe(false);
    expect(v1.isEqual(v4)).toBe(false);
  });

  it("toArrayは元の配列のコピーを返す", () => {
    const original = [1, 2, 3];
    const v = vector(original);
    const arr = v.toArray();
    arr[0] = 999;
    expect(v.toArray()[0]).toBe(1);
  });
});
