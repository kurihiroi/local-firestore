import type { MiddlewareHandler } from "hono";

/** レイテンシ分位点（直近リクエストのサンプルから計算） */
export interface ResponseTimePercentiles {
  p50: number;
  p90: number;
  p99: number;
}

/** サーバーメトリクス */
export interface ServerMetrics {
  uptime: number;
  totalRequests: number;
  activeRequests: number;
  requestsByMethod: Record<string, number>;
  requestsByStatus: Record<string, number>;
  averageResponseTime: number;
  /** 直近リクエスト（最大500件）のレイテンシ分位点 */
  responseTimePercentiles: ResponseTimePercentiles;
  lastRequestTime: string | null;
}

/** 分位点計算に使う直近サンプル数 */
const RECENT_SAMPLE_SIZE = 500;

/** メトリクスコレクター */
export class MetricsCollector {
  private startTime: number;
  private totalRequests = 0;
  private activeRequests = 0;
  private requestsByMethod: Record<string, number> = {};
  private requestsByStatus: Record<string, number> = {};
  private totalResponseTime = 0;
  private recentDurations: number[] = [];
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
    this.recentDurations.push(duration);
    if (this.recentDurations.length > RECENT_SAMPLE_SIZE) {
      this.recentDurations.splice(0, this.recentDurations.length - RECENT_SAMPLE_SIZE);
    }
  }

  private percentiles(): ResponseTimePercentiles {
    if (this.recentDurations.length === 0) {
      return { p50: 0, p90: 0, p99: 0 };
    }
    const sorted = [...this.recentDurations].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99) };
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
      responseTimePercentiles: this.percentiles(),
      lastRequestTime: this.lastRequestTime,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.activeRequests = 0;
    this.requestsByMethod = {};
    this.requestsByStatus = {};
    this.totalResponseTime = 0;
    this.recentDurations = [];
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
