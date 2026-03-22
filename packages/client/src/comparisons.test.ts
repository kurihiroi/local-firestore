import { describe, expect, it } from "vitest";
import { queryEqual, refEqual, snapshotEqual } from "./comparisons.js";
import type { Query } from "./query.js";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
import type { CollectionReference, DocumentReference } from "./types.js";
import { DocumentSnapshot } from "./types.js";

function makeDocRef(path: string): DocumentReference {
  return {
    type: "document",
    id: path.split("/").pop() ?? "",
    path,
    parent: {} as CollectionReference,
    firestore: {} as never,
    converter: null,
    _firestore: {} as never,
    _converter: null,
    withConverter: (() => {}) as never,
  };
}

function makeCollRef(path: string): CollectionReference {
  return {
    type: "collection",
    id: path.split("/").pop() ?? "",
    path,
    parent: null,
    firestore: {} as never,
    converter: null,
    _firestore: {} as never,
    _converter: null,
    withConverter: (() => {}) as never,
  };
}

describe("refEqual()", () => {
  it("同じパスのDocumentReferenceはtrueを返す", () => {
    const a = makeDocRef("users/alice");
    const b = makeDocRef("users/alice");
    expect(refEqual(a, b)).toBe(true);
  });

  it("異なるパスのDocumentReferenceはfalseを返す", () => {
    const a = makeDocRef("users/alice");
    const b = makeDocRef("users/bob");
    expect(refEqual(a, b)).toBe(false);
  });

  it("同じパスのCollectionReferenceはtrueを返す", () => {
    const a = makeCollRef("users");
    const b = makeCollRef("users");
    expect(refEqual(a, b)).toBe(true);
  });

  it("異なるパスのCollectionReferenceはfalseを返す", () => {
    const a = makeCollRef("users");
    const b = makeCollRef("posts");
    expect(refEqual(a, b)).toBe(false);
  });

  it("typeが異なる参照はfalseを返す", () => {
    const docRef = makeDocRef("users/alice");
    const collRef = makeCollRef("users/alice");
    // type が document vs collection なので false
    expect(refEqual(docRef, collRef as never)).toBe(false);
  });
});

describe("queryEqual()", () => {
  function makeQuery(
    collectionPath: string,
    collectionGroup: boolean,
    constraints: unknown[],
  ): Query {
    return {
      type: "query" as const,
      collectionPath,
      collectionGroup,
      constraints,
      _firestore: {} as never,
      _converter: null,
      withConverter: (() => {}) as never,
    } as unknown as Query;
  }

  it("同じクエリはtrueを返す", () => {
    const a = makeQuery("users", false, [{ type: "where", fieldPath: "age", op: "==", value: 30 }]);
    const b = makeQuery("users", false, [{ type: "where", fieldPath: "age", op: "==", value: 30 }]);
    expect(queryEqual(a, b)).toBe(true);
  });

  it("異なるcollectionPathはfalseを返す", () => {
    const a = makeQuery("users", false, []);
    const b = makeQuery("posts", false, []);
    expect(queryEqual(a, b)).toBe(false);
  });

  it("異なるcollectionGroupはfalseを返す", () => {
    const a = makeQuery("users", false, []);
    const b = makeQuery("users", true, []);
    expect(queryEqual(a, b)).toBe(false);
  });

  it("異なるconstraintsはfalseを返す", () => {
    const a = makeQuery("users", false, [{ type: "limit", limit: 10 }]);
    const b = makeQuery("users", false, [{ type: "limit", limit: 20 }]);
    expect(queryEqual(a, b)).toBe(false);
  });

  it("制約なしの同じクエリはtrueを返す", () => {
    const a = makeQuery("users", false, []);
    const b = makeQuery("users", false, []);
    expect(queryEqual(a, b)).toBe(true);
  });
});

describe("snapshotEqual()", () => {
  it("同じDocumentSnapshotはtrueを返す", () => {
    const ref = makeDocRef("users/alice");
    const a = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    const b = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    expect(snapshotEqual(a, b)).toBe(true);
  });

  it("データが異なるDocumentSnapshotはfalseを返す", () => {
    const ref = makeDocRef("users/alice");
    const a = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    const b = new DocumentSnapshot(ref, { name: "Bob" }, null, null);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("パスが異なるDocumentSnapshotはfalseを返す", () => {
    const a = new DocumentSnapshot(makeDocRef("users/alice"), { name: "Alice" }, null, null);
    const b = new DocumentSnapshot(makeDocRef("users/bob"), { name: "Alice" }, null, null);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("存在フラグが異なるDocumentSnapshotはfalseを返す", () => {
    const ref = makeDocRef("users/alice");
    const a = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    const b = new DocumentSnapshot(ref, null, null, null);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("同じQuerySnapshotはtrueを返す", () => {
    const doc1 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    const doc2 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    const a = new QuerySnapshot([doc1]);
    const b = new QuerySnapshot([doc2]);
    expect(snapshotEqual(a, b)).toBe(true);
  });

  it("サイズが異なるQuerySnapshotはfalseを返す", () => {
    const doc1 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    const a = new QuerySnapshot([doc1]);
    const b = new QuerySnapshot([]);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("ドキュメントデータが異なるQuerySnapshotはfalseを返す", () => {
    const doc1 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    const doc2 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Bob" }, "", "");
    const a = new QuerySnapshot([doc1]);
    const b = new QuerySnapshot([doc2]);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("ドキュメントパスが異なるQuerySnapshotはfalseを返す", () => {
    const doc1 = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    const doc2 = new QueryDocumentSnapshot("users/bob", "bob", { name: "Alice" }, "", "");
    const a = new QuerySnapshot([doc1]);
    const b = new QuerySnapshot([doc2]);
    expect(snapshotEqual(a, b)).toBe(false);
  });

  it("DocumentSnapshotとQuerySnapshotの比較はfalseを返す", () => {
    const ref = makeDocRef("users/alice");
    const docSnap = new DocumentSnapshot(ref, { name: "Alice" }, null, null);
    const querySnap = new QuerySnapshot([]);
    expect(snapshotEqual(docSnap, querySnap as never)).toBe(false);
  });
});
