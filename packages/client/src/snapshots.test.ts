import { describe, expect, it } from "vitest";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
import { SnapshotMetadata, Timestamp } from "./types.js";

describe("QueryDocumentSnapshot", () => {
  it("プロパティを正しく設定する", () => {
    const snap = new QueryDocumentSnapshot(
      "users/alice",
      "alice",
      { name: "Alice", age: 30 },
      "",
      "",
    );
    expect(snap.path).toBe("users/alice");
    expect(snap.id).toBe("alice");
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ name: "Alice", age: 30 });
  });

  it("metadataを持つ", () => {
    const snap = new QueryDocumentSnapshot("users/alice", "alice", {}, "", "");
    expect(snap.metadata).toBeInstanceOf(SnapshotMetadata);
    expect(snap.metadata.hasPendingWrites).toBe(false);
    expect(snap.metadata.fromCache).toBe(false);
  });

  it("get()でフィールド値を取得できる", () => {
    const snap = new QueryDocumentSnapshot(
      "users/alice",
      "alice",
      { name: "Alice", address: { city: "Tokyo" } },
      "",
      "",
    );
    expect(snap.get("name")).toBe("Alice");
    expect(snap.get("address.city")).toBe("Tokyo");
  });

  it("get()で存在しないフィールドはundefinedを返す", () => {
    const snap = new QueryDocumentSnapshot("users/alice", "alice", { name: "Alice" }, "", "");
    expect(snap.get("nonexistent")).toBeUndefined();
  });

  it("createTimeとupdateTimeをTimestampとして返す", () => {
    const snap = new QueryDocumentSnapshot(
      "users/alice",
      "alice",
      {},
      "2024-01-01T00:00:00.000Z",
      "2024-06-15T12:30:00.000Z",
    );
    expect(snap.createTime).toBeInstanceOf(Timestamp);
    expect(snap.updateTime).toBeInstanceOf(Timestamp);
  });

  it("firestore付きでrefを正しく生成する", () => {
    const mockFirestore = {
      type: "firestore" as const,
      _transport: {} as never,
    };
    const snap = new QueryDocumentSnapshot(
      "users/alice",
      "alice",
      { name: "Alice" },
      "",
      "",
      mockFirestore,
    );
    expect(snap.ref.type).toBe("document");
    expect(snap.ref.path).toBe("users/alice");
    expect(snap.ref.id).toBe("alice");
  });

  it("firestore未指定時はダミーrefを生成する", () => {
    const snap = new QueryDocumentSnapshot("users/alice", "alice", {}, "", "");
    expect(snap.ref.type).toBe("document");
    expect(snap.ref.id).toBe("alice");
    expect(snap.ref.path).toBe("users/alice");
  });
});

describe("QuerySnapshot", () => {
  function makeDocs(count: number): QueryDocumentSnapshot[] {
    return Array.from(
      { length: count },
      (_, i) => new QueryDocumentSnapshot(`users/user${i}`, `user${i}`, { index: i }, "", ""),
    );
  }

  it("docsを正しく保持する", () => {
    const docs = makeDocs(3);
    const snapshot = new QuerySnapshot(docs);
    expect(snapshot.docs).toHaveLength(3);
    expect(snapshot.docs[0].id).toBe("user0");
    expect(snapshot.docs[2].id).toBe("user2");
  });

  it("sizeでドキュメント数を返す", () => {
    const snapshot = new QuerySnapshot(makeDocs(5));
    expect(snapshot.size).toBe(5);
  });

  it("空の場合emptyがtrueを返す", () => {
    const snapshot = new QuerySnapshot([]);
    expect(snapshot.empty).toBe(true);
    expect(snapshot.size).toBe(0);
  });

  it("ドキュメントがある場合emptyがfalseを返す", () => {
    const snapshot = new QuerySnapshot(makeDocs(1));
    expect(snapshot.empty).toBe(false);
  });

  it("forEachで各ドキュメントを反復処理する", () => {
    const docs = makeDocs(3);
    const snapshot = new QuerySnapshot(docs);
    const ids: string[] = [];
    snapshot.forEach((doc) => {
      ids.push(doc.id);
    });
    expect(ids).toEqual(["user0", "user1", "user2"]);
  });

  it("docChanges()で変更一覧を返す", () => {
    const docs = makeDocs(1);
    const changes = [
      {
        type: "added" as const,
        doc: docs[0],
        oldIndex: -1,
        newIndex: 0,
      },
    ];
    const snapshot = new QuerySnapshot(docs, changes);
    expect(snapshot.docChanges()).toHaveLength(1);
    expect(snapshot.docChanges()[0].type).toBe("added");
    expect(snapshot.docChanges()[0].oldIndex).toBe(-1);
    expect(snapshot.docChanges()[0].newIndex).toBe(0);
  });

  it("changesが未指定の場合空配列を返す", () => {
    const snapshot = new QuerySnapshot(makeDocs(2));
    expect(snapshot.docChanges()).toEqual([]);
  });

  it("metadataを持つ", () => {
    const snapshot = new QuerySnapshot([]);
    expect(snapshot.metadata).toBeInstanceOf(SnapshotMetadata);
    expect(snapshot.metadata.hasPendingWrites).toBe(false);
    expect(snapshot.metadata.fromCache).toBe(false);
  });

  it("queryを保持する", () => {
    const mockQuery = { type: "query" as const } as never;
    const snapshot = new QuerySnapshot([], [], mockQuery);
    expect(snapshot.query).toBe(mockQuery);
  });
});
