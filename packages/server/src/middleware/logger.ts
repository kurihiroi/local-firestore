import type { MiddlewareHandler } from "hono";

/** ログレベル */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** ログエントリの構造 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

/** ログ出力先のインターフェース */
export interface LogOutput {
  write(entry: LogEntry): void;
}

/** コンソール出力（デフォルト） */
export class ConsoleLogOutput implements LogOutput {
  write(entry: LogEntry): void {
    const { timestamp, level, message, ...rest } = entry;
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
    const line = `${timestamp} [${level.toUpperCase()}] ${message}${extra}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

/** JSON出力（構造化ログ） */
export class JsonLogOutput implements LogOutput {
  write(entry: LogEntry): void {
    console.log(JSON.stringify(entry));
  }
}

/** Logger本体 */
export class Logger {
  private level: LogLevel;
  private output: LogOutput;

  constructor(options?: { level?: LogLevel; output?: LogOutput }) {
    this.level = options?.level ?? "info";
    this.output = options?.output ?? new ConsoleLogOutput();
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...extra,
    };
    this.output.write(entry);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log("error", message, extra);
  }
}

/** Honoミドルウェア: HTTPリクエストログ */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    logger.info(`--> ${method} ${path}`, { method, path });

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    const logMethod = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    logger[logMethod](`<-- ${method} ${path} ${status} ${duration}ms`, {
      method,
      path,
      status,
      duration,
    });
  };
}
