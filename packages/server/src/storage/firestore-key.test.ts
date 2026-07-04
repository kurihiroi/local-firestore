import { describe, expect, it } from "vitest";
import { arrayContainsKey, computeFirestoreKey, encodeNumber, valueKey } from "./firestore-key.js";

function ts(seconds: number, nanoseconds = 0) {
  return { __type: "timestamp", value: { seconds, nanoseconds } };
}

describe("firestore-key", () => {
  describe("encodeNumber", () => {
    it("数値の順序を保存する", () => {
      const values = [
        Number.NEGATIVE_INFINITY,
        -1e100,
        -2,
        -1.5,
        -1,
        -0.5,
        0,
        0.5,
        1,
        1.5,
        2,
        1e100,
        Number.POSITIVE_INFINITY,
      ];
      const keys = values.map(encodeNumber);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    it("-0 と 0 は同じキーになる", () => {
      expect(encodeNumber(-0)).toBe(encodeNumber(0));
    });

    it("整数と同値の浮動小数点数は同じキーになる", () => {
      expect(encodeNumber(1)).toBe(encodeNumber(1.0));
    });
  });

  describe("valueKey - 型順序", () => {
    it("Firestore の型順序 (null < boolean < number < timestamp < string < bytes < reference < geopoint < array < vector < map) を保存する", () => {
      const values: unknown[] = [
        null,
        false,
        true,
        42,
        ts(1700000000),
        "hello",
        { __type: "bytes", value: "aGVsbG8=" },
        { __type: "reference", value: "users/alice" },
        { __type: "geopoint", value: { latitude: 35, longitude: 139 } },
        [1, 2],
        { __type: "vector", values: [1, 2] },
        { a: 1 },
      ];
      const keys = values.map(valueKey);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    it("boolean は数値と区別される", () => {
      expect(valueKey(true)).not.toBe(valueKey(1));
      expect(valueKey(false)).not.toBe(valueKey(0));
    });
  });

  describe("valueKey - Timestamp", () => {
    it("時系列順を保存する", () => {
      const a = valueKey(ts(1700000000, 0));
      const b = valueKey(ts(1700000000, 500));
      const c = valueKey(ts(1700000001, 0));
      const d = valueKey(ts(-100, 0)); // epoch 以前
      expect(d < a).toBe(true);
      expect(a < b).toBe(true);
      expect(b < c).toBe(true);
    });
  });

  describe("valueKey - 文字列", () => {
    it("辞書式順序を保存する（プレフィックス関係を含む）", () => {
      expect(valueKey("a") < valueKey("ab")).toBe(true);
      expect(valueKey("ab") < valueKey("b")).toBe(true);
      expect(valueKey("") < valueKey("a")).toBe(true);
    });

    it("制御文字を含む文字列も順序を保存する", () => {
      expect(valueKey("a") < valueKey("a\u0000")).toBe(true);
      expect(valueKey("a\u0000") < valueKey("a\u0001")).toBe(true);
      expect(valueKey("a\u0001") < valueKey("ab")).toBe(true);
    });
  });

  describe("valueKey - 配列", () => {
    it("要素ごとの辞書式比較（短い方が先）", () => {
      expect(valueKey([1]) < valueKey([1, 2])).toBe(true);
      expect(valueKey([1, 2]) < valueKey([2])).toBe(true);
      // ネストした配列: [[1],[2]] < [[1,2]] (要素0: [1] < [1,2])
      expect(valueKey([[1], [2]]) < valueKey([[1, 2]])).toBe(true);
    });
  });

  describe("valueKey - マップ", () => {
    it("キー名 → 値の順で比較する", () => {
      expect(valueKey({ a: 1 }) < valueKey({ a: 2 })).toBe(true);
      expect(valueKey({ a: 1 }) < valueKey({ b: 0 })).toBe(true);
      expect(valueKey({ a: 1 })).toBe(valueKey({ a: 1 }));
    });

    it("キーの挿入順に依存しない", () => {
      expect(valueKey({ a: 1, b: 2 })).toBe(valueKey({ b: 2, a: 1 }));
    });
  });

  describe("computeFirestoreKey", () => {
    it("SQL NULL（フィールド欠損）は null を返す", () => {
      expect(computeFirestoreKey(null)).toBeNull();
      expect(computeFirestoreKey(undefined)).toBeNull();
    });

    it("JSON null は null 型キーを返す", () => {
      expect(computeFirestoreKey("null")).toBe(valueKey(null));
    });

    it("JSON テキストをパースしてキーを計算する", () => {
      expect(computeFirestoreKey('"abc"')).toBe(valueKey("abc"));
      expect(computeFirestoreKey("42")).toBe(valueKey(42));
      expect(computeFirestoreKey("true")).toBe(valueKey(true));
      expect(computeFirestoreKey('{"a":1}')).toBe(valueKey({ a: 1 }));
    });
  });

  describe("arrayContainsKey", () => {
    it("要素の Firestore 等値でマッチする", () => {
      expect(arrayContainsKey("[1,2,3]", valueKey(2))).toBe(true);
      expect(arrayContainsKey("[1,2,3]", valueKey(4))).toBe(false);
      // boolean true は数値 1 とマッチしない
      expect(arrayContainsKey("[1]", valueKey(true))).toBe(false);
    });

    it("オブジェクト要素も深い等値でマッチする", () => {
      const json = JSON.stringify([ts(100), "x"]);
      expect(arrayContainsKey(json, valueKey(ts(100)))).toBe(true);
      expect(arrayContainsKey(json, valueKey(ts(101)))).toBe(false);
    });

    it("配列でないフィールドはマッチしない", () => {
      expect(arrayContainsKey('"abc"', valueKey("abc"))).toBe(false);
      expect(arrayContainsKey(null, valueKey(1))).toBe(false);
    });
  });
});
