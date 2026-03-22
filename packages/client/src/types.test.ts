import { describe, expect, it } from "vitest";
import { createCollectionReference, createDocumentReference } from "./references.js";
import { DocumentSnapshot, FieldPath, SnapshotMetadata, Timestamp } from "./types.js";

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

  it("toJSONでseconds/nanosecondsオブジェクトを返す", () => {
    const ts = new Timestamp(100, 500);
    expect(ts.toJSON()).toEqual({ seconds: 100, nanoseconds: 500 });
  });

  it("toStringで文字列表現を返す", () => {
    const ts = new Timestamp(100, 500);
    expect(ts.toString()).toBe("Timestamp(seconds=100, nanoseconds=500)");
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

describe("DocumentSnapshot", () => {
  const mockFirestore = {
    type: "firestore" as const,
    _transport: {} as never,
  };

  function createRef(path: string, id: string) {
    const collPath = path.split("/").slice(0, -1).join("/");
    const collRef = createCollectionReference(mockFirestore, collPath);
    return createDocumentReference(mockFirestore, path, id, collRef);
  }

  it("getでフィールドの値を取得できる", () => {
    const ref = createRef("users/alice", "alice");
    const snap = new DocumentSnapshot(
      ref,
      { name: "Alice", address: { city: "Tokyo" } },
      null,
      null,
    );
    expect(snap.get("name")).toBe("Alice");
    expect(snap.get("address.city")).toBe("Tokyo");
    expect(snap.get(new FieldPath("address", "city"))).toBe("Tokyo");
  });

  it("getで存在しないフィールドはundefinedを返す", () => {
    const ref = createRef("users/alice", "alice");
    const snap = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    expect(snap.get("age")).toBeUndefined();
  });

  it("存在しないドキュメントのgetはundefinedを返す", () => {
    const ref = createRef("users/bob", "bob");
    const snap = new DocumentSnapshot(ref, null, null, null);
    expect(snap.get("name")).toBeUndefined();
  });

  it("metadataプロパティが存在する", () => {
    const ref = createRef("users/alice", "alice");
    const snap = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    expect(snap.metadata).toBeInstanceOf(SnapshotMetadata);
    expect(snap.metadata.hasPendingWrites).toBe(false);
    expect(snap.metadata.fromCache).toBe(false);
  });
});

describe("SnapshotMetadata", () => {
  it("isEqualで等値比較できる", () => {
    const m1 = new SnapshotMetadata(false, false);
    const m2 = new SnapshotMetadata(false, false);
    const m3 = new SnapshotMetadata(true, false);
    expect(m1.isEqual(m2)).toBe(true);
    expect(m1.isEqual(m3)).toBe(false);
  });
});
