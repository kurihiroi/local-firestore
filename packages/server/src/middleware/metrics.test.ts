import { describe, expect, it } from "vitest";
import { MetricsCollector, metricsMiddleware } from "./metrics.js";

describe("MetricsCollector", () => {
  it("should return initial metrics", () => {
    const collector = new MetricsCollector();
    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.activeRequests).toBe(0);
    expect(metrics.requestsByMethod).toEqual({});
    expect(metrics.requestsByStatus).toEqual({});
    expect(metrics.averageResponseTime).toBe(0);
    expect(metrics.lastRequestTime).toBeNull();
    expect(metrics.uptime).toBeGreaterThanOrEqual(0);
  });

  it("should track request start", () => {
    const collector = new MetricsCollector();
    collector.recordRequestStart();
    expect(collector.getMetrics().totalRequests).toBe(1);
    expect(collector.getMetrics().activeRequests).toBe(1);
    expect(collector.getMetrics().lastRequestTime).not.toBeNull();
  });

  it("should track request end", () => {
    const collector = new MetricsCollector();
    collector.recordRequestStart();
    collector.recordRequestEnd("GET", 200, 50);

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.activeRequests).toBe(0);
    expect(metrics.requestsByMethod).toEqual({ GET: 1 });
    expect(metrics.requestsByStatus).toEqual({ "2xx": 1 });
    expect(metrics.averageResponseTime).toBe(50);
  });

  it("should aggregate multiple requests", () => {
    const collector = new MetricsCollector();

    collector.recordRequestStart();
    collector.recordRequestEnd("GET", 200, 30);
    collector.recordRequestStart();
    collector.recordRequestEnd("POST", 201, 70);
    collector.recordRequestStart();
    collector.recordRequestEnd("GET", 404, 20);

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.requestsByMethod).toEqual({ GET: 2, POST: 1 });
    expect(metrics.requestsByStatus).toEqual({ "2xx": 2, "4xx": 1 });
    expect(metrics.averageResponseTime).toBe(40);
  });

  it("should reset metrics", () => {
    const collector = new MetricsCollector();
    collector.recordRequestStart();
    collector.recordRequestEnd("GET", 200, 10);
    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.activeRequests).toBe(0);
    expect(metrics.requestsByMethod).toEqual({});
  });
});

describe("responseTimePercentiles", () => {
  it("直近リクエストのレイテンシ分位点を返す", () => {
    const collector = new MetricsCollector();
    // 1..100ms の 100 サンプル
    for (let i = 1; i <= 100; i++) {
      collector.recordRequestStart();
      collector.recordRequestEnd("GET", 200, i);
    }
    const { responseTimePercentiles } = collector.getMetrics();
    expect(responseTimePercentiles.p50).toBeGreaterThanOrEqual(50);
    expect(responseTimePercentiles.p50).toBeLessThanOrEqual(52);
    expect(responseTimePercentiles.p90).toBeGreaterThanOrEqual(90);
    expect(responseTimePercentiles.p99).toBeGreaterThanOrEqual(99);
  });

  it("リクエストがない場合はゼロを返す", () => {
    const collector = new MetricsCollector();
    expect(collector.getMetrics().responseTimePercentiles).toEqual({ p50: 0, p90: 0, p99: 0 });
  });
});

describe("/metrics エンドポイントのゲージ", () => {
  it("購読数・接続数・トランザクション競合数を含む", async () => {
    const { createApp } = await import("../app.js");
    const { createDatabase } = await import("../storage/sqlite.js");
    const app = createApp(createDatabase(":memory:"));

    const res = await app.request("/metrics");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.activeSubscriptions).toBe(0);
    expect(body.subscribedConnections).toBe(0);
    expect(body.transactionConflicts).toBe(0);
    expect(body.responseTimePercentiles).toBeDefined();
  });
});

describe("metricsMiddleware", () => {
  it("should collect metrics from requests", async () => {
    const { Hono } = await import("hono");
    const collector = new MetricsCollector();

    const app = new Hono();
    app.use("*", metricsMiddleware(collector));
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.requestsByMethod.GET).toBe(2);
    expect(metrics.requestsByStatus["2xx"]).toBe(2);
  });
});
