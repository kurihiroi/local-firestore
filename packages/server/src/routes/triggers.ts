import type { ErrorResponse } from "@local-firestore/shared";
import { Hono } from "hono";
import type { TriggerEventType, TriggerService } from "../services/trigger.js";

/** トリガー登録リクエスト */
export interface RegisterTriggerRequest {
  collectionPattern: string;
  eventType: TriggerEventType;
  callbackUrl: string;
}

/** トリガー登録レスポンス */
export interface RegisterTriggerResponse {
  triggerId: string;
}

const EVENT_TYPES: ReadonlySet<string> = new Set(["create", "update", "delete", "write"]);

/**
 * Cloud Functions トリガーエミュレーション用の HTTP API
 *
 * 別プロセスで動作する関数ランタイムがコールバック URL を登録し、
 * ドキュメント変更時に TriggerEvent を受け取る。
 */
export function createTriggerRoutes(triggerService: TriggerService): Hono {
  const app = new Hono();

  // POST /triggers - Webhook トリガーを登録
  app.post("/triggers", async (c) => {
    const body = await c.req.json<Partial<RegisterTriggerRequest>>();

    if (typeof body.collectionPattern !== "string" || body.collectionPattern.length === 0) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "collectionPattern is required" },
        400,
      );
    }
    if (typeof body.eventType !== "string" || !EVENT_TYPES.has(body.eventType)) {
      return c.json<ErrorResponse>(
        {
          code: "invalid-argument",
          message: "eventType must be one of: create, update, delete, write",
        },
        400,
      );
    }
    if (typeof body.callbackUrl !== "string" || !isValidHttpUrl(body.callbackUrl)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "callbackUrl must be a valid http(s) URL" },
        400,
      );
    }

    const triggerId = triggerService.registerWebhook(
      body.collectionPattern,
      body.eventType,
      body.callbackUrl,
    );
    return c.json<RegisterTriggerResponse>({ triggerId }, 201);
  });

  // GET /triggers - 登録済みトリガーの一覧
  app.get("/triggers", (c) => {
    return c.json({ triggers: triggerService.list() });
  });

  // DELETE /triggers/:id - トリガーを解除
  app.delete("/triggers/:id", (c) => {
    const id = c.req.param("id");
    if (!triggerService.unregister(id)) {
      return c.json<ErrorResponse>({ code: "not-found", message: `Trigger not found: ${id}` }, 404);
    }
    return c.json({ success: true });
  });

  return app;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
