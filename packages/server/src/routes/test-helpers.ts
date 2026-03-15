import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createDatabase } from "../storage/sqlite.js";

export function createTestApp(): Hono {
  const db = createDatabase(":memory:");
  return createApp(db);
}

export async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

export async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}
