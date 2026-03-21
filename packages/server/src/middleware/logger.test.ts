import { describe, expect, it, vi } from "vitest";
import {
  ConsoleLogOutput,
  JsonLogOutput,
  type LogEntry,
  Logger,
  type LogOutput,
  requestLogger,
} from "./logger.js";

/** テスト用のログ出力先 */
class TestLogOutput implements LogOutput {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("Logger", () => {
  it("should log at info level by default", () => {
    const output = new TestLogOutput();
    const logger = new Logger({ output });

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(output.entries).toHaveLength(3);
    expect(output.entries[0].level).toBe("info");
    expect(output.entries[1].level).toBe("warn");
    expect(output.entries[2].level).toBe("error");
  });

  it("should respect log level setting", () => {
    const output = new TestLogOutput();
    const logger = new Logger({ level: "warn", output });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(output.entries).toHaveLength(2);
    expect(output.entries[0].level).toBe("warn");
    expect(output.entries[1].level).toBe("error");
  });

  it("should log all levels when set to debug", () => {
    const output = new TestLogOutput();
    const logger = new Logger({ level: "debug", output });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(output.entries).toHaveLength(4);
  });

  it("should include extra fields in log entries", () => {
    const output = new TestLogOutput();
    const logger = new Logger({ output });

    logger.info("test", { userId: "123", action: "login" });

    expect(output.entries[0].message).toBe("test");
    expect(output.entries[0].userId).toBe("123");
    expect(output.entries[0].action).toBe("login");
  });

  it("should include timestamp in log entries", () => {
    const output = new TestLogOutput();
    const logger = new Logger({ output });

    logger.info("test");

    expect(output.entries[0].timestamp).toBeDefined();
    expect(() => new Date(output.entries[0].timestamp)).not.toThrow();
  });
});

describe("ConsoleLogOutput", () => {
  it("should write to console.log for info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = new ConsoleLogOutput();

    output.write({ timestamp: "2026-01-01T00:00:00Z", level: "info", message: "test" });

    expect(spy).toHaveBeenCalledWith("2026-01-01T00:00:00Z [INFO] test");
    spy.mockRestore();
  });

  it("should write to console.error for error level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = new ConsoleLogOutput();

    output.write({ timestamp: "2026-01-01T00:00:00Z", level: "error", message: "test" });

    expect(spy).toHaveBeenCalledWith("2026-01-01T00:00:00Z [ERROR] test");
    spy.mockRestore();
  });

  it("should write to console.warn for warn level", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = new ConsoleLogOutput();

    output.write({ timestamp: "2026-01-01T00:00:00Z", level: "warn", message: "test" });

    expect(spy).toHaveBeenCalledWith("2026-01-01T00:00:00Z [WARN] test");
    spy.mockRestore();
  });

  it("should include extra fields in output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = new ConsoleLogOutput();

    output.write({
      timestamp: "2026-01-01T00:00:00Z",
      level: "info",
      message: "test",
      userId: "123",
    });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"userId":"123"'));
    spy.mockRestore();
  });
});

describe("JsonLogOutput", () => {
  it("should write JSON to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const output = new JsonLogOutput();

    const entry: LogEntry = {
      timestamp: "2026-01-01T00:00:00Z",
      level: "info",
      message: "test",
      extra: "data",
    };
    output.write(entry);

    const logged = JSON.parse(spy.mock.calls[0][0] as string) as LogEntry;
    expect(logged.level).toBe("info");
    expect(logged.message).toBe("test");
    expect(logged.extra).toBe("data");
    spy.mockRestore();
  });
});

describe("requestLogger middleware", () => {
  it("should log request and response", async () => {
    const output = new TestLogOutput();
    const logger = new Logger({ output });

    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", requestLogger(logger));
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");

    expect(output.entries).toHaveLength(2);
    // Request log
    expect(output.entries[0].message).toContain("--> GET /test");
    expect(output.entries[0].method).toBe("GET");
    // Response log
    expect(output.entries[1].message).toContain("<-- GET /test 200");
    expect(output.entries[1].status).toBe(200);
    expect(output.entries[1].duration).toBeDefined();
  });

  it("should log warn for 4xx responses", async () => {
    const output = new TestLogOutput();
    const logger = new Logger({ output });

    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", requestLogger(logger));
    app.get("/notfound", (c) => c.json({ error: "not found" }, 404));

    await app.request("/notfound");

    expect(output.entries[1].level).toBe("warn");
  });
});
