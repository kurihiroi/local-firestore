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
