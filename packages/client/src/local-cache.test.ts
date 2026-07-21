import { describe, expect, it, vi } from "vitest";
import { clearIndexedDbPersistence, enableIndexedDbPersistence, terminate } from "./firestore.js";
import { onSnapshotDoc, onSnapshotQuery } from "./listener.js";
import type { CacheStorageLike } from "./local-cache.js";
import {
  CACHE_SIZE_UNLIMITED,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
} from "./local-cache.js";
import { getLocalStore, LocalStore } from "./local-store.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";

/** Map ベースの Web Storage 互換フェイク */
function createFakeStorage(): CacheStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function createMockTransport() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ success: true, writeResults: [] }),
    put: vi.fn().mockResolvedValue({ success: true, updateTime: "2026-01-01T00:00:00.000001Z" }),
    patch: vi.fn().mockResolvedValue({ success: true, updateTime: "2026-01-01T00:00:00.000001Z" }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    getWebSocketUrl: vi.fn(),
    getAuthToken: () => Promise.resolve(null),
  };
}

function createFirestore(storage?: CacheStorageLike): Firestore {
  return {
    type: "firestore",
    _transport: createMockTransport(),
    _localCache: storage ? persistentLocalCache({ storage }) : undefined,
  } as unknown as Firestore;
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

describe("ローカルキャッシュ設定 API", () => {
  it("memoryLocalCache / persistentLocalCache が設定オブジェクトを返す", () => {
    expect(memoryLocalCache()).toEqual({ kind: "memory" });
    expect(persistentLocalCache().kind).toBe("persistent");
    expect(persistentSingleTabManager(undefined).kind).toBe("persistentSingleTab");
    expect(persistentMultipleTabManager().kind).toBe("persistentMultipleTab");
    expect(CACHE_SIZE_UNLIMITED).toBe(-1);
  });
});

describe("persistentLocalCache の永続化", () => {
  it("キャッシュ済みスナップショットと保留中の書き込みが永続化・復元される", async () => {
    const storage = createFakeStorage();

    // インスタンスA: リモート確定値 + 保留中の書き込み
    const fsA = createFirestore(storage);
    const storeA = new LocalStore(fsA);
    storeA.applyRemoteDoc("users/alice", true, { name: "Alice" }, "t1", "t1");
    // 送信を止めて pending のまま永続化させる
    (fsA._transport.put as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    void storeA.enqueue([{ type: "set", path: "users/bob", data: { name: "Bob" } }]);
    expect(storage.data.size).toBe(1);

    // インスタンスB（リロード後想定）: 同じストレージから復元される
    const fsB = createFirestore(storage);
    const storeB = new LocalStore(fsB);
    expect(storeB.composeDocument("users/alice")).toMatchObject({
      exists: true,
      data: { name: "Alice" },
      fromCache: false,
    });
    // 復元された保留書き込みはローカルビューに反映され、自動再送される
    expect(storeB.composeDocument("users/bob")).toMatchObject({
      exists: true,
      data: { name: "Bob" },
      hasPendingWrites: true,
    });
    await vi.waitFor(() => {
      expect(fsB._transport.put).toHaveBeenCalledWith("/docs/users/bob", expect.anything());
    });
  });

  it("ack された書き込みは永続化対象から外れる", async () => {
    const storage = createFakeStorage();
    const fs = createFirestore(storage);
    const store = new LocalStore(fs);

    await store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);

    const persisted = JSON.parse(storage.data.values().next().value as string) as {
      mutations: unknown[];
    };
    expect(persisted.mutations).toHaveLength(0);
  });

  it("壊れた永続データがあっても空キャッシュで開始する", () => {
    const storage = createFakeStorage();
    storage.setItem("local-firestore/cache/(default)", "{not json");

    const fs = createFirestore(storage);
    const store = new LocalStore(fs);
    expect(store.composeDocument("users/alice")).toBeNull();
    expect(store.pendingMutationCount).toBe(0);
  });

  it("localCache 未指定（インメモリ）では何も永続化されない", () => {
    const storage = createFakeStorage();
    const fs = createFirestore(); // localCache なし
    const store = new LocalStore(fs);
    store.applyRemoteDoc("users/alice", true, { name: "Alice" }, "t1", "t1");
    expect(storage.data.size).toBe(0);
  });
});

describe("terminate() の遮断", () => {
  it("terminate 後の操作は failed-precondition で拒否される", async () => {
    const fs = createFirestore();
    await terminate(fs);

    const ref = createMockDocRef(fs, "users/alice");
    await expect((await import("./crud.js")).getDoc(ref)).rejects.toMatchObject({
      code: "failed-precondition",
    });
    await expect((await import("./crud.js")).setDoc(ref, { name: "x" })).rejects.toMatchObject({
      code: "failed-precondition",
    });
    expect(() => onSnapshotDoc(ref, () => {})).toThrow(/terminated/);
    expect(() => onSnapshotQuery(createMockCollRef(fs, "users"), () => {})).toThrow(/terminated/);
    const { writeBatch } = await import("./batch.js");
    expect(() => writeBatch(fs)).toThrow(/terminated/);
  });

  it("terminate は冪等で、2回目も成功する", async () => {
    const fs = createFirestore();
    await terminate(fs);
    await expect(terminate(fs)).resolves.toBeUndefined();
  });
});

describe("enableIndexedDbPersistence / clearIndexedDbPersistence", () => {
  it("開始前の enableIndexedDbPersistence は永続キャッシュを有効にする", async () => {
    const fs = createFirestore();
    await enableIndexedDbPersistence(fs);
    expect(fs._localCache?.kind).toBe("persistent");
  });

  it("開始後の enableIndexedDbPersistence は failed-precondition", async () => {
    const fs = createFirestore();
    getLocalStore(fs); // 使用開始
    await expect(enableIndexedDbPersistence(fs)).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("clearIndexedDbPersistence は開始前または terminate 後のみ許可され、データを削除する", async () => {
    const storage = createFakeStorage();
    storage.setItem("local-firestore/cache/(default)", '{"remoteDocs":[],"mutations":[]}');

    const fs = createFirestore(storage);
    getLocalStore(fs);
    await expect(clearIndexedDbPersistence(fs)).rejects.toMatchObject({
      code: "failed-precondition",
    });

    await terminate(fs);
    await clearIndexedDbPersistence(fs);
    expect(storage.data.size).toBe(0);
  });
});

describe("onSnapshot の source: 'cache'", () => {
  it("doc リスナー: サーバー購読なしでキャッシュから即時発火し、ローカル書き込みで更新される", async () => {
    const fs = createFirestore();
    const ref = createMockDocRef(fs, "users/alice");
    const snapshots: Array<{ exists: boolean; data: unknown; fromCache: boolean }> = [];

    const unsubscribe = onSnapshotDoc(
      ref,
      (snap) => {
        snapshots.push({
          exists: snap.exists(),
          data: snap.data(),
          fromCache: snap.metadata.fromCache,
        });
      },
      undefined,
      { source: "cache" },
    );

    // 初回: キャッシュに状態がない → exists: false, fromCache: true
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ exists: false, fromCache: true });

    // ローカル書き込みで発火する（サーバー購読なし）
    await getLocalStore(fs).enqueue([{ type: "set", path: "users/alice", data: { name: "A" } }]);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      exists: true,
      data: { name: "A" },
    });

    unsubscribe();
  });

  it("query リスナー: キャッシュの既知ドキュメントから結果を合成し、ローカル変更を追従する", async () => {
    const fs = createFirestore();
    const store = getLocalStore(fs);
    store.applyRemoteDoc("tasks/1", true, { title: "T1", done: true }, "t1", "t1");
    store.applyRemoteDoc("tasks/2", true, { title: "T2", done: false }, "t1", "t1");

    const collRef = createMockCollRef(fs, "tasks");
    const results: string[][] = [];
    const unsubscribe = onSnapshotQuery(
      collRef,
      (snap) => {
        results.push(snap.docs.map((d) => d.ref.path));
      },
      undefined,
      { source: "cache" },
    );

    // 初回: キャッシュ済みの2件
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(["tasks/1", "tasks/2"]);

    // ローカル追加が反映される
    await store.enqueue([{ type: "set", path: "tasks/3", data: { title: "T3" } }]);
    expect(results[results.length - 1]).toEqual(["tasks/1", "tasks/2", "tasks/3"]);

    unsubscribe();
  });
});
