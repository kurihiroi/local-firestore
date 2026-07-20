import { describe, expect, it } from "vitest";
import {
  arrayContainsKey,
  computeFirestoreKey,
  encodeNumber,
  pathOrderKey,
  valueKey,
} from "./firestore-key.js";

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

    it("NaN は数値の最小として扱われる（本家仕様: NaN < -Infinity）", () => {
      expect(encodeNumber(Number.NaN) < encodeNumber(Number.NEGATIVE_INFINITY)).toBe(true);
      expect(encodeNumber(Number.NaN) < encodeNumber(-1e308)).toBe(true);
      // NaN 同士は同じキー（== NaN フィルタが成立する）
      expect(encodeNumber(Number.NaN)).toBe(encodeNumber(Number.NaN));
    });
  });

  describe("valueKey - double ラッパー（NaN / Infinity）", () => {
    it("double ラッパーは数値としてエンコードされる", () => {
      expect(valueKey({ __type: "double", value: "Infinity" })).toBe(
        valueKey(Number.POSITIVE_INFINITY),
      );
      expect(valueKey({ __type: "double", value: "-Infinity" })).toBe(
        valueKey(Number.NEGATIVE_INFINITY),
      );
      expect(valueKey({ __type: "double", value: "NaN" })).toBe(valueKey(Number.NaN));
    });

    it("NaN ラッパーは全ての数値より小さく、null / boolean より大きい", () => {
      const nanKey = valueKey({ __type: "double", value: "NaN" });
      expect(nanKey > valueKey(true)).toBe(true);
      expect(nanKey < valueKey(Number.NEGATIVE_INFINITY)).toBe(true);
      expect(nanKey < valueKey(0)).toBe(true);
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

    it("サロゲートペア（U+10000 以上）は UTF-8 バイト順で BMP 文字より後になる", () => {
      // JS の生比較（UTF-16 コード単位順）ではサロゲート（0xD800〜）が
      // U+E000〜U+FFFF より手前に来てしまう（本家と逆順）
      expect("\u{1F600}" < "\uE000").toBe(true);
      // 本家の UTF-8 バイト順ではコードポイント順になる
      expect(valueKey("\uE000") < valueKey("\u{1F600}")).toBe(true);
      expect(valueKey("\uFFFF") < valueKey("\u{10000}")).toBe(true);
    });

    it("コードポイント順の全域ソートを保存する", () => {
      // ASCII → latin1 → ひらがな → 私用領域 → BMP 末尾 → 絵文字（astral）
      const strings = [
        "A",
        "a",
        "\u00A2",
        "あ",
        "ん",
        "\uE000",
        "\uFFFD",
        "\u{1F600}",
        "\u{1F680}",
      ];
      const keys = strings.map(valueKey);
      expect([...keys].sort()).toEqual(keys);
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

    it("マップキーは UTF-8 バイト順で比較される", () => {
      // "\uE000" < "\u{1F600}"（UTF-8 順）なので最初の差分キーは "\uE000" の値。
      // UTF-16 順で誤ソートすると "\u{1F600}" の値（0 vs 1）で比較され結果が反転する
      const a = { "\uE000": 9, "\u{1F600}": 0 };
      const b = { "\uE000": 8, "\u{1F600}": 1 };
      expect(valueKey(b) < valueKey(a)).toBe(true);
      // 挿入順にも依存しない
      expect(valueKey({ "\u{1F600}": 0, "\uE000": 9 })).toBe(valueKey(a));
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

  describe("pathOrderKey", () => {
    it("セグメント単位の順序を保存する（完全リソース名順）", () => {
      // 生のパス文字列比較では "-"（U+002D）< "/"（U+002F）のため
      // "users/user-1/..." < "users/user/..." になってしまうが、
      // 本家のセグメント順では "user" < "user-1"
      const a = pathOrderKey("users/user/posts/x");
      const b = pathOrderKey("users/user-1/posts/y");
      expect("users/user/posts/x" > "users/user-1/posts/y").toBe(true); // 生比較は逆順
      expect(a < b).toBe(true); // セグメント順は user < user-1

      // 通常ケース（"/" より大きい文字のみ）は生比較と同じ順序
      expect(pathOrderKey("items/a") < pathOrderKey("items/b")).toBe(true);
      expect(pathOrderKey("items/a") < pathOrderKey("shelf/s1/items/x")).toBe(true);
    });

    it("プレフィックス関係のパスは短い方が先", () => {
      expect(pathOrderKey("col/doc") < pathOrderKey("col/doc-2")).toBe(true);
      expect(pathOrderKey("col/doc/sub/x") < pathOrderKey("col/doc-2/sub/x")).toBe(true);
    });

    it("reference 型の valueKey と同じセグメント順序を使う", () => {
      const refA = valueKey({ __type: "reference", value: "users/user/posts/x" });
      const refB = valueKey({ __type: "reference", value: "users/user-1/posts/y" });
      expect(refA < refB).toBe(true);
    });
  });

  describe("エンコード出力の固定値", () => {
    // キーは実行時計算のみで永続化されないが、リグレッション検出のため
    // 代表値のエンコード出力を固定する。文字列 / bytes は UTF-8 バイト順化
    // （#39）で各文字が UTF-8 バイト列（latin1 1文字 = 1バイト）へ展開される。
    it("encodeNumber の出力が変わっていない", () => {
      expect(encodeNumber(0)).toBe("8000000000000000");
      expect(encodeNumber(1)).toBe("bff0000000000000");
      expect(encodeNumber(-1)).toBe("400fffffffffffff");
      expect(encodeNumber(1.5)).toBe("bff8000000000000");
      expect(encodeNumber(-1e100)).toBe("2b4db652da6b3c82");
      expect(encodeNumber(Number.POSITIVE_INFINITY)).toBe("fff0000000000000");
      expect(encodeNumber(Number.NEGATIVE_INFINITY)).toBe("000fffffffffffff");
      expect(encodeNumber(Number.NaN)).toBe("0000000000000000");
    });

    it("bytes キー（base64 → latin1 → UTF-8 バイト展開）の出力が一致する", () => {
      // バイト列 [0x68, 0xc3, 0xa9, 0x00, 0x01, 0xff]（マルチバイト・制御文字含む）
      // 0x80 以上のバイトは UTF-8 の2バイト形（C2/C3 + 継続バイト）へ展開される
      const b64 = Buffer.from([0x68, 0xc3, 0xa9, 0x00, 0x01, 0xff]).toString("base64");
      expect(valueKey({ __type: "bytes", value: b64 })).toBe(
        "6h\u00c3\u0083\u00c2\u00a9\u0002\u0001\u0002\u0002\u00c3\u00bf\u0001",
      );
    });

    it("timestamp キーの出力が変わっていない", () => {
      expect(
        valueKey({ __type: "timestamp", value: { seconds: 1700000000, nanoseconds: 123456000 } }),
      ).toBe("4c1d954fc40000000123456000");
    });
  });
});
