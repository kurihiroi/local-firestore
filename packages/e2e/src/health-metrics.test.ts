import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Health & Metrics", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T15.1: /health should return 200", async () => {
    const res = await fetch(`http://localhost:${ctx.port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("T15.2: /metrics should return metrics data", async () => {
    const res = await fetch(`http://localhost:${ctx.port}/metrics`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBeDefined();
  });
});
