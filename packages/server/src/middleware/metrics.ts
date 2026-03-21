import type { MiddlewareHandler } from "hono";

/** サーバーメトリクス */
export interface ServerMetrics {
  uptime: number;
  totalRequests: number;
  activeRequests: number;
  requestsByMethod: Record<string, number>;
  requestsByStatus: Record<string, number>;
  averageResponseTime: number;
  lastRequestTime: string | null;
}

/** メトリクスコレクター */
export class MetricsCollector {
  private startTime: number;
  private totalRequests = 0;
  private activeRequests = 0;
  private requestsByMethod: Record<string, number> = {};
  private requestsByStatus: Record<string, number> = {};
  private totalResponseTime = 0;
  private lastRequestTime: string | null = null;

  constructor() {
    this.startTime = Date.now();
  }

  recordRequestStart(): void {
    this.totalRequests++;
    this.activeRequests++;
    this.lastRequestTime = new Date().toISOString();
  }

  recordRequestEnd(method: string, status: number, duration: number): void {
    this.activeRequests--;
    this.requestsByMethod[method] = (this.requestsByMethod[method] ?? 0) + 1;
    const statusGroup = `${Math.floor(status / 100)}xx`;
    this.requestsByStatus[statusGroup] = (this.requestsByStatus[statusGroup] ?? 0) + 1;
    this.totalResponseTime += duration;
  }

  getMetrics(): ServerMetrics {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      totalRequests: this.totalRequests,
      activeRequests: this.activeRequests,
      requestsByMethod: { ...this.requestsByMethod },
      requestsByStatus: { ...this.requestsByStatus },
      averageResponseTime:
        this.totalRequests > 0 ? Math.round(this.totalResponseTime / this.totalRequests) : 0,
      lastRequestTime: this.lastRequestTime,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.activeRequests = 0;
    this.requestsByMethod = {};
    this.requestsByStatus = {};
    this.totalResponseTime = 0;
    this.lastRequestTime = null;
  }
}

/** メトリクス収集ミドルウェア */
export function metricsMiddleware(collector: MetricsCollector): MiddlewareHandler {
  return async (c, next) => {
    collector.recordRequestStart();
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    collector.recordRequestEnd(c.req.method, c.res.status, duration);
  };
}
