import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDatabase } from "../storage/sqlite.js";

describe("リクエストボディサイズ上限（過負荷防御）", () => {
  it("上限を超えるボディは 413 を返す", async () => {
    const app = createApp(createDatabase(":memory:"), undefined, { maxRequestBodyBytes: 256 });

    const res = await app.request("/docs/users/alice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { text: "x".repeat(1024) } }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid-argument");
  });

  it("上限内のボディは通常どおり処理される", async () => {
    const app = createApp(createDatabase(":memory:"), undefined, { maxRequestBodyBytes: 4096 });

    const res = await app.request("/docs/users/alice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { name: "Alice" } }),
    });

    expect(res.status).toBe(200);
  });

  it("maxRequestBodyBytes: 0 で無効化できる", async () => {
    const app = createApp(createDatabase(":memory:"), undefined, { maxRequestBodyBytes: 0 });

    const res = await app.request("/docs/users/alice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { text: "x".repeat(1024) } }),
    });

    expect(res.status).toBe(200);
  });
});
