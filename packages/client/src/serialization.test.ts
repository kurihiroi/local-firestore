import { describe, expect, it } from "vitest";
import { Bytes } from "./bytes.js";
import { arrayUnion, serverTimestamp } from "./field-values.js";
import { getFirestore } from "./firestore.js";
import { GeoPoint } from "./geo-point.js";
import { doc } from "./references.js";
import { deserializeData, serializeData, serializeValue } from "./serialization.js";
import { Timestamp } from "./types.js";
import { VectorValue } from "./vector.js";

describe("serialization", () => {
  const firestore = getFirestore({ host: "localhost", port: 9999 });

  describe("serializeValue", () => {
    it("Timestamp を {__type: timestamp} 形式に変換する", () => {
      const ts = new Timestamp(1700000000, 500);
      expect(serializeValue(ts)).toEqual({
        __type: "timestamp",
        value: { seconds: 1700000000, nanoseconds: 500 },
      });
    });

    it("Date を Timestamp として変換する", () => {
      const date = new Date("2025-01-15T10:30:00Z");
      const serialized = serializeValue(date) as { __type: string; value: { seconds: number } };
      expect(serialized.__type).toBe("timestamp");
      expect(serialized.value.seconds).toBe(Math.floor(date.getTime() / 1000));
    });

    it("GeoPoint / Bytes / VectorValue を変換する", () => {
      expect(serializeValue(new GeoPoint(35, 139))).toEqual({
        __type: "geopoint",
        value: { latitude: 35, longitude: 139 },
      });
      expect(serializeValue(Bytes.fromBase64String("aGVsbG8="))).toEqual({
        __type: "bytes",
        value: "aGVsbG8=",
      });
      expect(serializeValue(VectorValue.fromArray([1, 2]))).toEqual({
        __type: "vector",
        values: [1, 2],
      });
    });

    it("DocumentReference をパスに変換する", () => {
      const ref = doc(firestore, "users/alice");
      expect(serializeValue(ref)).toEqual({ __type: "reference", value: "users/alice" });
    });

    it("ネストしたマップ・配列を再帰的に変換する", () => {
      const ts = new Timestamp(100, 0);
      const result = serializeData({
        nested: { at: ts },
        list: [ts, "plain"],
      });
      expect(result).toEqual({
        nested: { at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } } },
        list: [{ __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } }, "plain"],
      });
    });

    it("undefined フィールドは除外される", () => {
      expect(serializeData({ a: 1, b: undefined })).toEqual({ a: 1 });
    });

    it("FieldValue センチネルは維持しつつ内部の値を変換する", () => {
      const sentinel = serializeValue(arrayUnion(new Timestamp(100, 0))) as {
        __fieldValue: true;
        type: string;
        value: unknown[];
      };
      expect(sentinel.__fieldValue).toBe(true);
      expect(sentinel.type).toBe("arrayUnion");
      expect(sentinel.value).toEqual([
        { __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } },
      ]);
      // serverTimestamp はそのまま
      expect(serializeValue(serverTimestamp())).toEqual(serverTimestamp());
    });
  });

  describe("deserializeData", () => {
    it("{__type: timestamp} を Timestamp インスタンスに復元する", () => {
      const data = deserializeData(
        { at: { __type: "timestamp", value: { seconds: 1700000000, nanoseconds: 500 } } },
        firestore,
      );
      expect(data.at).toBeInstanceOf(Timestamp);
      expect((data.at as Timestamp).seconds).toBe(1700000000);
      expect((data.at as Timestamp).nanoseconds).toBe(500);
    });

    it("GeoPoint / Bytes / VectorValue を復元する", () => {
      const data = deserializeData(
        {
          geo: { __type: "geopoint", value: { latitude: 35, longitude: 139 } },
          bin: { __type: "bytes", value: "aGVsbG8=" },
          vec: { __type: "vector", values: [1, 2] },
        },
        firestore,
      );
      expect(data.geo).toBeInstanceOf(GeoPoint);
      expect(data.bin).toBeInstanceOf(Bytes);
      expect(data.vec).toBeInstanceOf(VectorValue);
    });

    it("{__type: reference} を DocumentReference に復元する", () => {
      const data = deserializeData(
        { ref: { __type: "reference", value: "users/alice" } },
        firestore,
      );
      const ref = data.ref as { type: string; path: string; id: string };
      expect(ref.type).toBe("document");
      expect(ref.path).toBe("users/alice");
      expect(ref.id).toBe("alice");
    });

    it("ネスト構造を再帰的に復元する", () => {
      const data = deserializeData(
        {
          nested: { at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } } },
          list: [{ __type: "timestamp", value: { seconds: 200, nanoseconds: 0 } }],
        },
        firestore,
      );
      expect((data.nested as Record<string, unknown>).at).toBeInstanceOf(Timestamp);
      expect((data.list as unknown[])[0]).toBeInstanceOf(Timestamp);
    });

    it("round-trip で元の値に戻る", () => {
      const original = {
        at: new Timestamp(1700000000, 500),
        geo: new GeoPoint(35, 139),
        nested: { list: [new Timestamp(1, 2)] },
        plain: { seconds: 1, nanoseconds: 2 }, // 素のマップは変換されない
      };
      const restored = deserializeData(serializeData(original), firestore);
      expect(restored.at).toBeInstanceOf(Timestamp);
      expect((restored.at as Timestamp).isEqual(original.at)).toBe(true);
      expect(restored.geo).toBeInstanceOf(GeoPoint);
      expect((restored.nested as { list: unknown[] }).list[0]).toBeInstanceOf(Timestamp);
      expect(restored.plain).toEqual({ seconds: 1, nanoseconds: 2 });
    });
  });
});
