import { describe, expect, it, vi } from "vitest";
import * as connectionModule from "./connection.js";
import { onSnapshot, onSnapshotDoc, onSnapshotQuery, onSnapshotsInSync } from "./listener.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";

function createMockManager() {
  const stateListeners = new Set<(state: string) => void>();
  return {
    connect: vi.fn().mockReturnValue({}),
    hasMessageHandler: false,
    setMessageHandler: vi.fn().mockImplementation(function (this: { hasMessageHandler: boolean }) {
      this.hasMessageHandler = true;
    }),
    registerSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    addStateListener: vi.fn().mockImplementation((listener: (state: string) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
    _stateListeners: stateListeners,
  };
}

function createMockFirestore(): Firestore {
  return {
    type: "firestore",
    _transport: { getWebSocketUrl: () => "ws://localhost:8080" },
  } as Firestore;
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

describe("onSnapshotDoc()", () => {
  it("サブスクリプションを登録しUnsubscribe関数を返す", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const ref = createMockDocRef(firestore, "users/alice");
    const onNext = vi.fn();

    const unsubscribe = onSnapshotDoc(ref, onNext);

    expect(manager.connect).toHaveBeenCalled();
    expect(manager.setMessageHandler).toHaveBeenCalled();
    expect(manager.registerSubscription).toHaveBeenCalled();
    expect(typeof unsubscribe).toBe("function");

    // unsubscribe を呼ぶと removeSubscription が呼ばれる
    unsubscribe();
    expect(manager.removeSubscription).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe("onSnapshotQuery()", () => {
  it("クエリのサブスクリプションを登録する", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const collRef = createMockCollRef(firestore, "users");
    const onNext = vi.fn();

    const unsubscribe = onSnapshotQuery(collRef, onNext);

    expect(manager.connect).toHaveBeenCalled();
    expect(manager.registerSubscription).toHaveBeenCalled();

    // 登録メッセージにsubscribe_queryタイプが含まれることを確認
    const registeredMessage = manager.registerSubscription.mock.calls[0][1];
    const parsed = JSON.parse(registeredMessage);
    expect(parsed.type).toBe("subscribe_query");
    expect(parsed.collectionPath).toBe("users");

    unsubscribe();
    expect(manager.removeSubscription).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("Query型のターゲットに対してsubscribe_queryを送信する", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const mockQuery = {
      type: "query" as const,
      collectionPath: "users",
      collectionGroup: false,
      constraints: [{ type: "where", fieldPath: "age", op: ">", value: 18 }],
      _firestore: firestore,
      _converter: null,
      withConverter: (() => {}) as never,
    };

    const onNext = vi.fn();
    const unsubscribe = onSnapshotQuery(mockQuery as never, onNext);

    const registeredMessage = manager.registerSubscription.mock.calls[0][1];
    const parsed = JSON.parse(registeredMessage);
    expect(parsed.type).toBe("subscribe_query");
    expect(parsed.collectionPath).toBe("users");
    expect(parsed.collectionGroup).toBe(false);
    expect(parsed.constraints).toHaveLength(1);

    unsubscribe();
    vi.restoreAllMocks();
  });
});

describe("onSnapshot()", () => {
  it("DocumentReferenceの場合ドキュメントリスナーを設定する", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const ref = createMockDocRef(firestore, "users/alice");
    const onNext = vi.fn();

    const unsubscribe = onSnapshot(ref, onNext);

    const registeredMessage = manager.registerSubscription.mock.calls[0][1];
    const parsed = JSON.parse(registeredMessage);
    expect(parsed.type).toBe("subscribe_doc");
    expect(parsed.path).toBe("users/alice");

    unsubscribe();
    vi.restoreAllMocks();
  });

  it("CollectionReferenceの場合クエリリスナーを設定する", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const collRef = createMockCollRef(firestore, "users");
    const onNext = vi.fn();

    const unsubscribe = onSnapshot(collRef, onNext);

    const registeredMessage = manager.registerSubscription.mock.calls[0][1];
    const parsed = JSON.parse(registeredMessage);
    expect(parsed.type).toBe("subscribe_query");

    unsubscribe();
    vi.restoreAllMocks();
  });

  it("Observer形式で呼び出せる", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const ref = createMockDocRef(firestore, "users/alice");

    const unsubscribe = onSnapshot(ref, {
      next: vi.fn(),
      error: vi.fn(),
    });

    expect(manager.registerSubscription).toHaveBeenCalled();

    unsubscribe();
    vi.restoreAllMocks();
  });

  it("Observer形式でnextが未定義でもエラーにならない", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const ref = createMockDocRef(firestore, "users/alice");

    const unsubscribe = onSnapshot(ref, {});

    expect(manager.registerSubscription).toHaveBeenCalled();

    unsubscribe();
    vi.restoreAllMocks();
  });
});

describe("onSnapshotsInSync()", () => {
  it("connected状態でコールバックが呼ばれる", () => {
    const manager = createMockManager();
    vi.spyOn(connectionModule, "getConnectionManager").mockReturnValue(
      manager as unknown as connectionModule.ConnectionManager,
    );

    const firestore = createMockFirestore();
    const callback = vi.fn();

    const unsubscribe = onSnapshotsInSync(firestore, callback);

    // addStateListenerに渡されたリスナーを取得して手動で呼び出し
    const stateListener = manager.addStateListener.mock.calls[0][0];
    stateListener("connected");
    expect(callback).toHaveBeenCalledTimes(1);

    // disconnected状態ではコールバックは呼ばれない
    stateListener("disconnected");
    expect(callback).toHaveBeenCalledTimes(1);

    expect(typeof unsubscribe).toBe("function");

    vi.restoreAllMocks();
  });
});
