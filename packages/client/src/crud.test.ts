import { describe, expect, it, vi } from "vitest";
import { addDoc, deleteDoc, getDoc, setDoc, updateDoc } from "./crud.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";
import { DocumentSnapshot, FieldPath } from "./types.js";

function createMockTransport() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://localhost:8080"),
  };
}

function createMockFirestore(transport: ReturnType<typeof createMockTransport>): Firestore {
  return { type: "firestore", _transport: transport } as unknown as Firestore;
}

function createMockDocRef(
  firestore: Firestore,
  path: string,
  converter: null = null,
): DocumentReference {
  const id = path.split("/").pop() ?? "";
  return {
    type: "document",
    id,
    path,
    parent: {} as CollectionReference,
    firestore,
    converter,
    _firestore: firestore,
    _converter: converter,
    withConverter: (() => {}) as never,
  };
}

function createMockCollRef(firestore: Firestore, path: string): CollectionReference {
  const id = path.split("/").pop() ?? "";
  return {
    type: "collection",
    id,
    path,
    parent: null,
    firestore,
    converter: null,
    _firestore: firestore,
    _converter: null,
    withConverter: (() => {}) as never,
  };
}

describe("getDoc()", () => {
  it("存在するドキュメントのDocumentSnapshotを返す", async () => {
    const transport = createMockTransport();
    transport.get.mockResolvedValue({
      exists: true,
      data: { name: "Alice", age: 30 },
      createTime: "2024-01-01T00:00:00Z",
      updateTime: "2024-01-02T00:00:00Z",
    });

    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");
    const snapshot = await getDoc(ref);

    expect(snapshot).toBeInstanceOf(DocumentSnapshot);
    expect(snapshot.exists()).toBe(true);
    expect(snapshot.data()).toEqual({ name: "Alice", age: 30 });
    expect(transport.get).toHaveBeenCalledWith("/docs/users/alice");
  });

  it("存在しないドキュメントのDocumentSnapshotを返す", async () => {
    const transport = createMockTransport();
    transport.get.mockResolvedValue({
      exists: false,
      data: null,
      createTime: null,
      updateTime: null,
    });

    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/nonexistent");
    const snapshot = await getDoc(ref);

    expect(snapshot.exists()).toBe(false);
    expect(snapshot.data()).toBeUndefined();
  });

  it("コンバーター付きでfromFirestoreを呼び出す", async () => {
    const transport = createMockTransport();
    transport.get.mockResolvedValue({
      exists: true,
      data: { name: "Alice", age: 30 },
      createTime: "2024-01-01T00:00:00Z",
      updateTime: "2024-01-02T00:00:00Z",
    });

    const firestore = createMockFirestore(transport);
    const converter = {
      toFirestore: vi.fn(),
      fromFirestore: vi.fn().mockReturnValue({ displayName: "Alice (30)" }),
    };
    const ref = {
      ...createMockDocRef(firestore, "users/alice"),
      converter,
      _converter: converter,
    } as unknown as DocumentReference;

    const snapshot = await getDoc(ref);
    expect(converter.fromFirestore).toHaveBeenCalled();
    expect(snapshot.data()).toEqual({ displayName: "Alice (30)" });
  });
});

describe("setDoc()", () => {
  it("transportのputを呼び出す", async () => {
    const transport = createMockTransport();
    transport.put.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await setDoc(ref, { name: "Alice", age: 30 });

    expect(transport.put).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Alice", age: 30 },
      options: undefined,
    });
  });

  it("mergeオプション付きで呼び出せる", async () => {
    const transport = createMockTransport();
    transport.put.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await setDoc(ref, { name: "Alice" }, { merge: true });

    expect(transport.put).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Alice" },
      options: { merge: true },
    });
  });

  it("コンバーター付きでtoFirestoreを呼び出す", async () => {
    const transport = createMockTransport();
    transport.put.mockResolvedValue({});
    const firestore = createMockFirestore(transport);

    const converter = {
      toFirestore: vi.fn().mockReturnValue({ name: "Converted" }),
      fromFirestore: vi.fn(),
    };
    const ref = {
      ...createMockDocRef(firestore, "users/alice"),
      converter,
      _converter: converter,
    } as unknown as DocumentReference;

    await setDoc(ref, { original: true } as never);

    expect(converter.toFirestore).toHaveBeenCalled();
    expect(transport.put).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Converted" },
      options: undefined,
    });
  });
});

describe("addDoc()", () => {
  it("クライアント生成 ID で set として書き込み DocumentReference を返す", async () => {
    const transport = createMockTransport();
    transport.put.mockResolvedValue({ success: true });
    const firestore = createMockFirestore(transport);
    const collRef = createMockCollRef(firestore, "users");

    const result = await addDoc(collRef, { name: "Bob" });

    // 本家同様、ID はクライアント側で生成して PUT（set）で書き込む
    expect(result.type).toBe("document");
    expect(result.id).toHaveLength(20);
    expect(transport.put).toHaveBeenCalledWith(`/docs/users/${result.id}`, {
      data: { name: "Bob" },
      options: undefined,
    });
  });
});

describe("updateDoc()", () => {
  it("オブジェクト形式でtransportのpatchを呼び出す", async () => {
    const transport = createMockTransport();
    transport.patch.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await updateDoc(ref, { age: 31 });

    expect(transport.patch).toHaveBeenCalledWith("/docs/users/alice", { data: { age: 31 } });
  });

  it("フィールドパス形式で呼び出せる", async () => {
    const transport = createMockTransport();
    transport.patch.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await updateDoc(ref, "age", 31);

    expect(transport.patch).toHaveBeenCalledWith("/docs/users/alice", {
      data: { age: 31 },
    });
  });

  it("ドット記法のフィールドパスでネストされた値を設定する", async () => {
    const transport = createMockTransport();
    transport.patch.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await updateDoc(ref, "address.city", "Osaka");

    // ドット記法キーはリーフ更新としてそのまま送信される（サーバー側で深いマージ）
    expect(transport.patch).toHaveBeenCalledWith("/docs/users/alice", {
      data: { "address.city": "Osaka" },
    });
  });

  it("複数のフィールドパスペアで呼び出せる", async () => {
    const transport = createMockTransport();
    transport.patch.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await updateDoc(ref, "name", "Alice Updated", "age", 32);

    expect(transport.patch).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Alice Updated", age: 32 },
    });
  });

  it("FieldPathオブジェクトで呼び出せる", async () => {
    const transport = createMockTransport();
    transport.patch.mockResolvedValue({});
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await updateDoc(ref, new FieldPath("address", "city"), "Nagoya");

    expect(transport.patch).toHaveBeenCalledWith("/docs/users/alice", {
      data: { "address.city": "Nagoya" },
    });
  });

  it("フィールドパス形式でvalueがない場合エラーを投げる", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    // 実装のオーバーロードをバイパスしてフィールドパス形式で値なし呼び出しをテスト
    const updateDocImpl = updateDoc as unknown as (
      ref: DocumentReference,
      field: string,
    ) => Promise<void>;
    await expect(updateDocImpl(ref, "field")).rejects.toThrow(
      "updateDoc with field path requires a value argument",
    );
  });
});

describe("deleteDoc()", () => {
  it("transportのdeleteを呼び出す", async () => {
    const transport = createMockTransport();
    transport.delete.mockResolvedValue({ success: true });
    const firestore = createMockFirestore(transport);
    const ref = createMockDocRef(firestore, "users/alice");

    await deleteDoc(ref);

    expect(transport.delete).toHaveBeenCalledWith("/docs/users/alice");
  });
});
