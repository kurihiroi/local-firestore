import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { TriggerEvent } from "../services/trigger.js";
import { TriggerService } from "../services/trigger.js";
import { createDatabase } from "../storage/sqlite.js";
import { jsonBody, request } from "./test-helpers.js";

describe("Trigger Routes", () => {
  let app: Hono;
  let triggerService: TriggerService;

  beforeEach(() => {
    const db = createDatabase(":memory:");
    triggerService = new TriggerService();
    app = createApp(db, undefined, { triggerService });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /triggers", () => {
    it("Webhook トリガーを登録できる", async () => {
      const res = await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "create",
        callbackUrl: "http://localhost:9999/on-create",
      });
      expect(res.status).toBe(201);
      const body = await jsonBody<{ triggerId: string }>(res);
      expect(body.triggerId).toMatch(/^trigger_/);
      expect(triggerService.size).toBe(1);
    });

    it("collectionPattern がないと400を返す", async () => {
      const res = await request(app, "POST", "/triggers", {
        eventType: "create",
        callbackUrl: "http://localhost:9999/cb",
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("不正な eventType で400を返す", async () => {
      const res = await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "invalid",
        callbackUrl: "http://localhost:9999/cb",
      });
      expect(res.status).toBe(400);
    });

    it("不正な callbackUrl で400を返す", async () => {
      const res = await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "create",
        callbackUrl: "not-a-url",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /triggers", () => {
    it("登録済みトリガーの一覧を返す", async () => {
      await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "write",
        callbackUrl: "http://localhost:9999/cb",
      });

      const res = await request(app, "GET", "/triggers");
      expect(res.status).toBe(200);
      const body = await jsonBody<{
        triggers: Array<{ id: string; collectionPattern: string; callbackUrl?: string }>;
      }>(res);
      expect(body.triggers).toHaveLength(1);
      expect(body.triggers[0]).toMatchObject({
        collectionPattern: "users",
        eventType: "write",
        callbackUrl: "http://localhost:9999/cb",
      });
    });
  });

  describe("DELETE /triggers/:id", () => {
    it("トリガーを解除できる", async () => {
      const createRes = await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "create",
        callbackUrl: "http://localhost:9999/cb",
      });
      const { triggerId } = await jsonBody<{ triggerId: string }>(createRes);

      const res = await request(app, "DELETE", `/triggers/${triggerId}`);
      expect(res.status).toBe(200);
      expect(triggerService.size).toBe(0);
    });

    it("存在しないトリガーIDで404を返す", async () => {
      const res = await request(app, "DELETE", "/triggers/trigger_none");
      expect(res.status).toBe(404);
    });
  });

  describe("Webhook 発火", () => {
    it("ドキュメント作成時に callbackUrl へ TriggerEvent が POST される", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "create",
        callbackUrl: "http://localhost:9999/on-create",
      });

      await request(app, "PUT", "/docs/users/alice", { data: { name: "Alice" } });

      // notifyChange は非同期 (fire-and-forget) なので待機
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:9999/on-create");
      const event = JSON.parse(String(init.body)) as TriggerEvent;
      expect(event.type).toBe("create");
      expect(event.path).toBe("users/alice");
      expect(event.newData).toEqual({ name: "Alice" });
    });

    it("イベント種別が一致しない場合は発火しない", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await request(app, "POST", "/triggers", {
        collectionPattern: "users",
        eventType: "delete",
        callbackUrl: "http://localhost:9999/on-delete",
      });

      await request(app, "PUT", "/docs/users/alice", { data: { name: "Alice" } });

      // 少し待っても fetch は呼ばれない
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
