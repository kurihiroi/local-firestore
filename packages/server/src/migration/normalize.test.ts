import { describe, expect, it } from "vitest";
import {
  LEGACY_DELETE_MARKER,
  normalizeLegacyDocumentData,
  truncateTimestampsToMicros,
} from "./normalize.js";

describe("truncateTimestampsToMicros", () => {
  it("ナノ秒をマイクロ秒精度に切り捨てる", () => {
    const data = {
      at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 123_456_789 } },
    };
    const result = truncateTimestampsToMicros(data);
    expect(result.at).toEqual({
      __type: "timestamp",
      value: { seconds: 100, nanoseconds: 123_456_000 },
    });
  });

  it("ネストしたマップ・配列内の Timestamp も切り捨てる", () => {
    const data = {
      nested: { at: { __type: "timestamp", value: { seconds: 1, nanoseconds: 999 } } },
      list: [{ __type: "timestamp", value: { seconds: 2, nanoseconds: 1001 } }],
    };
    const result = truncateTimestampsToMicros(data) as typeof data;
    expect(result.nested.at.value.nanoseconds).toBe(0);
    expect(result.list[0].value.nanoseconds).toBe(1000);
  });

  it("変更がない場合は同一参照を返す", () => {
    const data = {
      at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 123_456_000 } },
      name: "Alice",
    };
    expect(truncateTimestampsToMicros(data)).toBe(data);
  });

  it("素の {seconds, nanoseconds} マップは変換しない（通常の書き込みパス）", () => {
    const data = { userMap: { seconds: 1, nanoseconds: 999 } };
    expect(truncateTimestampsToMicros(data)).toBe(data);
  });
});

describe("normalizeLegacyDocumentData", () => {
  it("素の {seconds, nanoseconds} マップを timestamp ラッパーへ変換する", () => {
    const { data, stats } = normalizeLegacyDocumentData({
      createdAt: { seconds: 1700000000, nanoseconds: 500_000_000 },
    });
    expect(data.createdAt).toEqual({
      __type: "timestamp",
      value: { seconds: 1700000000, nanoseconds: 500_000_000 },
    });
    expect(stats.timestampsConverted).toBe(1);
  });

  it("変換時にナノ秒も切り捨てる", () => {
    const { data, stats } = normalizeLegacyDocumentData({
      createdAt: { seconds: 1, nanoseconds: 123_456_789 },
    });
    expect(data.createdAt).toEqual({
      __type: "timestamp",
      value: { seconds: 1, nanoseconds: 123_456_000 },
    });
    expect(stats.timestampsConverted).toBe(1);
    expect(stats.nanosecondsTruncated).toBe(1);
  });

  it("Timestamp に見えないマップは変換しない", () => {
    const inputs = [
      { seconds: 1, nanoseconds: 2, extra: 3 }, // キーが多い
      { seconds: "1", nanoseconds: 2 }, // 型が違う
      { seconds: 1, nanoseconds: 1_000_000_000 }, // 範囲外
      { seconds: 1.5, nanoseconds: 2 }, // 非整数
    ];
    for (const input of inputs) {
      const { data, stats } = normalizeLegacyDocumentData({ v: input });
      expect(data.v).toEqual(input);
      expect(stats.timestampsConverted).toBe(0);
    }
  });

  it("旧 deleteField 文字列を検出してフィールドパスを記録する", () => {
    const { data, stats } = normalizeLegacyDocumentData({
      note: LEGACY_DELETE_MARKER,
      nested: { gone: LEGACY_DELETE_MARKER },
    });
    // 変換はしない（レポートのみ）
    expect(data.note).toBe(LEGACY_DELETE_MARKER);
    expect(stats.legacyDeleteMarkerFields.sort()).toEqual(["nested.gone", "note"]);
  });

  it("特殊型ラッパーの内部には踏み込まない", () => {
    const { data, stats } = normalizeLegacyDocumentData({
      geo: { __type: "geopoint", value: { latitude: 1, longitude: 2 } },
    });
    expect(data.geo).toEqual({ __type: "geopoint", value: { latitude: 1, longitude: 2 } });
    expect(stats.timestampsConverted).toBe(0);
  });
});
