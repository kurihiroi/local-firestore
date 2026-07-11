import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnectionManager } from "./connection.js";
import { addDoc, deleteDoc, setDoc } from "./crud.js";
import {
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
  getFirestore,
  waitForPendingWrites,
} from "./firestore.js";
import { getLocalStore } from "./local-store.js";
import { isNetworkEnabled } from "./network-state.js";
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
  it("disableNetwork 中の書き込みは MutationQueue に保持されローカルビューへ即時反映される", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    expect(isNetworkEnabled(firestore)).toBe(false);

    // オフライン中の書き込み Promise はサーバー確定まで pending（本家同様、await しない）
    const p1 = setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });
    const p2 = deleteDoc(createMockDocRef(firestore, "users/carol"));

    expect(transport.put).not.toHaveBeenCalled();
    expect(transport.delete).not.toHaveBeenCalled();

    const store = getLocalStore(firestore);
    expect(store.pendingMutationCount).toBe(2);

    // ローカルビューには即時反映されている（レイテンシ補償）
    expect(store.composeDocument("users/alice")).toMatchObject({
      exists: true,
      data: { name: "Alice" },
      hasPendingWrites: true,
      fromCache: true,
    });
    expect(store.composeDocument("users/carol")).toMatchObject({ exists: false });

    await enableNetwork(firestore);
    await Promise.all([p1, p2]);
  });

  it("disableNetwork 中の addDoc はクライアント生成 ID でキューに積まれる", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    let resolvedRef: { id: string; path: string } | undefined;
    const pending = addDoc(createMockCollRef(firestore, "users"), { name: "Dave" }).then((ref) => {
      resolvedRef = ref;
      return ref;
    });

    await Promise.resolve();
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.put).not.toHaveBeenCalled();
    expect(getLocalStore(firestore).pendingMutationCount).toBe(1);
    expect(resolvedRef).toBeUndefined(); // サーバー確定まで pending

    await enableNetwork(firestore);
    const ref = await pending;
    expect(ref.id).toHaveLength(20);
    expect(ref.path).toBe(`users/${ref.id}`);
    expect(transport.put).toHaveBeenCalledWith(`/docs/${ref.path}`, {
      data: { name: "Dave" },
      options: undefined,
    });
  });

  it("enableNetwork でキュー済みの書き込みが順番にフラッシュされる", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);

    const p1 = setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });
    const p2 = deleteDoc(createMockDocRef(firestore, "users/bob"));

    await enableNetwork(firestore);
    await Promise.all([p1, p2]);

    expect(isNetworkEnabled(firestore)).toBe(true);
    expect(transport.put).toHaveBeenCalledWith("/docs/users/alice", {
      data: { name: "Alice" },
      options: undefined,
    });
    expect(transport.delete).toHaveBeenCalledWith("/docs/users/bob");
    expect(getLocalStore(firestore).pendingMutationCount).toBe(0);
  });

  it("enableNetwork 後の書き込みは直接サーバーに送信される", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    await enableNetwork(firestore);

    await setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

    expect(transport.put).toHaveBeenCalledTimes(1);
    expect(getLocalStore(firestore).pendingMutationCount).toBe(0);
  });
});

describe("waitForPendingWrites()", () => {
  it("キューが空なら即座に resolve する", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await expect(waitForPendingWrites(firestore)).resolves.toBeUndefined();
  });

  it("キュー済みの書き込みが確定するまで待機する", async () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    const write = setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

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
    await write;
  });

  it("書き込みが失敗しても resolve し、失敗は書き込み側の Promise で通知される", async () => {
    const transport = createMockTransport();
    transport.put.mockRejectedValue(new Error("network error"));
    const firestore = createMockFirestore(transport);
    await disableNetwork(firestore);
    const write = setDoc(createMockDocRef(firestore, "users/alice"), { name: "Alice" });

    const pending = waitForPendingWrites(firestore);
    await enableNetwork(firestore);
    await expect(pending).resolves.toBeUndefined();
    await expect(write).rejects.toThrow("network error");

    // 失敗した mutation はロールバックされている
    expect(getLocalStore(firestore).pendingMutationCount).toBe(0);
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

describe("getFirestore(FirebaseApp)", () => {
  const fakeApp = { name: "[DEFAULT]", options: { projectId: "demo" } };

  it("FirebaseApp を渡すと同一インスタンスが返る（本家互換）", () => {
    const db1 = getFirestore(fakeApp);
    const db2 = getFirestore(fakeApp);
    expect(db1).toBe(db2);
  });

  it("databaseId ごとに別インスタンスがキャッシュされる", () => {
    const db1 = getFirestore(fakeApp);
    const db2 = getFirestore(fakeApp, "other-db");
    expect(db1).not.toBe(db2);
    expect(getFirestore(fakeApp, "other-db")).toBe(db2);
  });

  it("FirebaseApp インスタンスには authTokenProvider が自動配線される", () => {
    const db = getFirestore(fakeApp);
    // firebase/auth 未インストール環境ではトークンは null になる（エラーにならない）
    expect(db._transport.getAuthTokenProvider()).toBeDefined();
  });

  it("FirestoreSettings は従来どおり毎回新しいインスタンスを返す", () => {
    const db1 = getFirestore({ host: "localhost", port: 8080 });
    const db2 = getFirestore({ host: "localhost", port: 8080 });
    expect(db1).not.toBe(db2);
  });
});

describe("connectFirestoreEmulator()", () => {
  it("接続先ホスト/ポートを差し替える", () => {
    const db = getFirestore({ name: "app", options: {} });
    connectFirestoreEmulator(db, "127.0.0.1", 9099);
    expect(db._transport.getBaseUrl()).toBe("http://127.0.0.1:9099");
  });

  it("databaseId のプレフィックスを維持する", () => {
    const db = getFirestore({ host: "localhost", port: 8080 }, "my-db");
    connectFirestoreEmulator(db, "127.0.0.1", 9099);
    expect(db._transport.getBaseUrl()).toBe("http://127.0.0.1:9099/databases/my-db");
  });

  it("既存の authTokenProvider を引き継ぐ", async () => {
    const db = getFirestore({
      host: "localhost",
      port: 8080,
      authTokenProvider: () => "token-1",
    });
    connectFirestoreEmulator(db, "127.0.0.1", 9099);
    expect(await db._transport.getAuthToken()).toBe("token-1");
  });

  it("mockUserToken (文字列) をトークンとして送信する", async () => {
    const db = getFirestore({ host: "localhost", port: 8080 });
    connectFirestoreEmulator(db, "127.0.0.1", 9099, { mockUserToken: "raw-token" });
    expect(await db._transport.getAuthToken()).toBe("raw-token");
  });

  it("mockUserToken (オブジェクト) は uid:claims 形式へ変換される", async () => {
    const db = getFirestore({ host: "localhost", port: 8080 });
    connectFirestoreEmulator(db, "127.0.0.1", 9099, {
      mockUserToken: { sub: "alice", admin: true },
    });
    const token = await db._transport.getAuthToken();
    expect(token).toBe(`alice:${JSON.stringify({ sub: "alice", admin: true })}`);
  });

  it("使用開始後に呼び出すとエラーになる", () => {
    const db = getFirestore({ host: "localhost", port: 8080 });
    getConnectionManager(db); // リスナー登録などで接続が開始された状態を再現
    expect(() => connectFirestoreEmulator(db, "127.0.0.1", 9099)).toThrowError(
      /already been started/,
    );
  });
});
