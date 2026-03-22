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
