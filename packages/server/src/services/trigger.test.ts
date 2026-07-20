import type { DocumentMetadata } from "@local-firestore/shared";
import { describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "./trigger.js";
import { TriggerService } from "./trigger.js";

function makeDoc(path: string, data: Record<string, unknown>): DocumentMetadata {
  return {
    path,
    collectionPath: path.split("/").slice(0, -1).join("/"),
    documentId: path.split("/").pop()!,
    data,
    version: 1,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
  };
}

describe("TriggerService", () => {
  it("onCreate トリガーが新規ドキュメントで発火する", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onCreate("users", handler);

    const newDoc = makeDoc("users/alice", { name: "Alice" });
    await service.notifyChange("users/alice", undefined, newDoc);

    expect(handler).toHaveBeenCalledOnce();
    const event: TriggerEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("create");
    expect(event.newData).toEqual({ name: "Alice" });
    expect(event.oldData).toBeUndefined();
  });

  it("onUpdate トリガーが更新時に発火する", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onUpdate("users", handler);

    const oldDoc = makeDoc("users/alice", { name: "Alice" });
    const newDoc = makeDoc("users/alice", { name: "Alice Updated" });
    await service.notifyChange("users/alice", oldDoc, newDoc);

    expect(handler).toHaveBeenCalledOnce();
    const event: TriggerEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("update");
  });

  it("onDelete トリガーが削除時に発火する", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onDelete("users", handler);

    const oldDoc = makeDoc("users/alice", { name: "Alice" });
    await service.notifyChange("users/alice", oldDoc, undefined);

    expect(handler).toHaveBeenCalledOnce();
    const event: TriggerEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("delete");
  });

  it("onWrite トリガーが全変更種別で発火する", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onWrite("users", handler);

    const doc = makeDoc("users/alice", { name: "Alice" });

    await service.notifyChange("users/alice", undefined, doc); // create
    await service.notifyChange("users/alice", doc, doc); // update
    await service.notifyChange("users/alice", doc, undefined); // delete

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("ワイルドカードパターンでマッチする", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onCreate("users/{userId}/posts", handler);

    const newDoc = makeDoc("users/alice/posts/post1", { title: "Hello" });
    await service.notifyChange("users/alice/posts/post1", undefined, newDoc);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("マッチしないパターンでは発火しない", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    service.onCreate("posts", handler);

    const newDoc = makeDoc("users/alice", { name: "Alice" });
    await service.notifyChange("users/alice", undefined, newDoc);

    expect(handler).not.toHaveBeenCalled();
  });

  it("unregister でトリガーを解除できる", async () => {
    const service = new TriggerService();
    const handler = vi.fn();
    const id = service.onCreate("users", handler);

    service.unregister(id);

    const newDoc = makeDoc("users/alice", { name: "Alice" });
    await service.notifyChange("users/alice", undefined, newDoc);

    expect(handler).not.toHaveBeenCalled();
  });

  it("clear で全トリガーをクリアできる", () => {
    const service = new TriggerService();
    service.onCreate("a", vi.fn());
    service.onUpdate("b", vi.fn());
    expect(service.size).toBe(2);

    service.clear();
    expect(service.size).toBe(0);
  });
});

describe("at-least-once 配信（リトライ / デッドレター / 永続化）", () => {
  it("ハンドラ失敗はバックオフ後にリトライされる", async () => {
    vi.useFakeTimers();
    try {
      const service = new TriggerService(undefined, { initialBackoffMs: 100 });
      const handler = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
      service.onCreate("users", handler);

      await service.notifyChange("users/a", undefined, makeDoc("users/a", { v: 1 }));
      expect(handler).toHaveBeenCalledTimes(1);

      // バックオフ（100ms）後に自動リトライされ、成功する
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(2);

      // 成功後は再実行されない
      await vi.advanceTimersByTimeAsync(10_000);
      expect(handler).toHaveBeenCalledTimes(2);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("最大試行回数を超えるとデッドレターへ退避され、再キューできる", async () => {
    vi.useFakeTimers();
    try {
      const service = new TriggerService(undefined, { initialBackoffMs: 100, maxAttempts: 2 });
      const handler = vi.fn().mockRejectedValue(new Error("always fails"));
      service.onCreate("users", handler);

      await service.notifyChange("users/a", undefined, makeDoc("users/a", { v: 1 }));
      await vi.advanceTimersByTimeAsync(100); // 2 回目の失敗 → デッドレター
      expect(handler).toHaveBeenCalledTimes(2);

      const dead = service.listDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0].attempts).toBe(2);
      expect(dead[0].lastError).toBe("always fails");
      expect(dead[0].event.path).toBe("users/a");

      // それ以上リトライされない
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(2);

      // 再キューすると再配信される（今度は成功させる）
      handler.mockResolvedValue(undefined);
      expect(service.retryDeadLetter(dead[0].id)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(3);
      expect(service.listDeadLetters()).toHaveLength(0);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("存在しないデッドレターの再キューは false", () => {
    const service = new TriggerService();
    expect(service.retryDeadLetter(999)).toBe(false);
  });

  it("Webhook 登録と未配信イベントは SQLite に永続化され、再起動後に配信される", async () => {
    vi.useFakeTimers();
    try {
      const { createDatabase } = await import("../storage/sqlite.js");
      const db = createDatabase(":memory:");

      // 1 回目の「プロセス」: Webhook 配信が失敗し、イベントがキューに残る
      const failingFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
      vi.stubGlobal("fetch", failingFetch);
      const service1 = new TriggerService(db, { initialBackoffMs: 1000 });
      service1.registerWebhook("users", "create", "http://localhost:9999/hook");
      await service1.notifyChange("users/a", undefined, makeDoc("users/a", { v: 1 }));
      expect(failingFetch).toHaveBeenCalledTimes(1);
      service1.dispose();

      // 2 回目の「プロセス」: 同じ DB から Webhook 登録と未配信イベントが復元される
      const okFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", okFetch);
      const service2 = new TriggerService(db, { initialBackoffMs: 1000 });
      expect(service2.list()).toHaveLength(1);
      expect(service2.list()[0].callbackUrl).toBe("http://localhost:9999/hook");

      // バックオフ経過後に永続キューから再配信される
      await vi.advanceTimersByTimeAsync(1000);
      expect(okFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse((okFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.path).toBe("users/a");
      service2.dispose();
      db.close();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
