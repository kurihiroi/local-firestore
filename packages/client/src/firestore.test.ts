import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, deleteDoc, setDoc, updateDoc } from "./crud.js";
import { disableNetwork, enableNetwork, getFirestore, waitForPendingWrites } from "./firestore.js";
import { getWriteQueue, isNetworkEnabled } from "./network-state.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";

/** connect() が実接続を張らないようにするための Mock WebSocket */
class MockWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send(_data: string): void {}
  close(): void {
    this.readyState = 3;
  }
  addEventListener(_event: string, _handler: () => void, _options?: { once?: boolean }): void {}
}

function createMockTransport() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ documentId: "server-id" }),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://localhost:8080/ws"),
  };
}

function createMockFirestore(transport: ReturnType<typeof createMockTransport>): Firestore {
  return { type: "firestore", _transport: transport } as unknown as Firestore;
}

function createMockDocRef(firestore: Firestore, path: string): DocumentReference {
  const id = path.split("/").pop() ?? "";
  return {
    type: "document",
    id,
    path,
    parent: {} as CollectionReference,
    firestore,
    converter: null,
    _firestore: firestore,
    _converter: null,
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

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("disableNetwork() / enableNetwork()", () => {
  it("disableNetwork 中の書き込みは WriteQueue にエンキューされる", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    expect(isNetworkEnabled(firestore)).toBe(false);

    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });
    await updateDoc(createMockDocRef(firestore, "users/bob"), { age: 30 });
    await deleteDoc(createMockDocRef(firestore, "users/carol"));

    expect(transport.put).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
    expect(transport.delete).not.toHaveBeenCalled();

    const queue = getWriteQueue(firestore);
    expect(queue.size).toBe(3);
    expect(queue.pendingWrites.map((w) => w.type)).toEqual(["set", "update", "delete"]);
  });

  it("disableNetwork 中の addDoc はクライアント生成 ID の参照を返しキューに積む", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    const ref = await addDoc(createMockCollRef(firestore, "users"), { name: "Dave" });

    expect(transport.post).not.toHaveBeenCalled();
    expect(ref.id).toHaveLength(20);
    expect(ref.path).toBe(`users/${ref.id}`);

    const queue = getWriteQueue(firestore);
    expect(queue.size).toBe(1);
    expect(queue.pendingWrites[0]).toMatchObject({ type: "set", path: ref.path });
  });

  it("enableNetwork でキュー済みの書き込みがフラッシュされる", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });
    await deleteDoc(createMockDocRef(firestore, "users/bob"));

    await enableNetwork(firestore);

    expect(isNetworkEnabled(firestore)).toBe(true);
    expect(transport.put).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Alice" },
      options: undefined,
    });
    expect(transport.delete).toHaveBeenCalledWith("/docs/users/bob");
    expect(getWriteQueue(firestore).size).toBe(0);
  });

  it("enableNetwork 後の書き込みは直接サーバーに送信される", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    await enableNetwork(firestore);

    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

    expect(transport.put).toHaveBeenCalledTimes(1);
    expect(getWriteQueue(firestore).size).toBe(0);
  });
});

describe("waitForPendingWrites()", () => {
  it("キューが空なら即座に resolve する", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await expect(waitForPendingWrites(firestore)).resolves.toBeUndefined();
  });

  it("キューがフラッシュされるまで待機する", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

    let resolved = false;
    const pending = waitForPendingWrites(firestore).then(() => {
      resolved = true;
    });

    // フラッシュ前は未解決
    await Promise.resolve();
    expect(resolved).toBe(false);

    await enableNetwork(firestore);
    await pending;
    expect(resolved).toBe(true);
  });

  it("フラッシュが失敗したら reject する", async () => {
    const transport = createMockTransport();
    transport.put.mockRejectedValue(new Error("network error"));
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

    const pending = waitForPendingWrites(firestore);
    await enableNetwork(firestore);
    await expect(pending).rejects.toThrow("Failed to flush queued write");
  });
});

describe("getFirestore() のマルチデータベース対応", () => {
  it("デフォルトでは (default) データベースに接続する", () => {
    const db = getFirestore();
    expect(db._databaseId).toBe("(default)");
    expect(db._transport.getBaseUrl()).toBe("http://localhost:8080");
  });

  it("settings + databaseId でデータベースを指定できる", () => {
    const db = getFirestore({ host: "localhost", port: 9090 }, "my-db");
    expect(db._databaseId).toBe("my-db");
    expect(db._transport.getBaseUrl()).toBe("http://localhost:9090/databases/my-db");
  });

  it("app + databaseId 形式でもデータベースを指定できる", () => {
    const db = getFirestore({ name: "app" }, "db2");
    expect(db._databaseId).toBe("db2");
    expect(db._transport.getBaseUrl()).toBe("http://localhost:8080/databases/db2");
  });

  it("(default) を明示指定した場合はプレフィックスなし", () => {
    const db = getFirestore(undefined, "(default)");
    expect(db._databaseId).toBe("(default)");
    expect(db._transport.getBaseUrl()).toBe("http://localhost:8080");
  });
});
