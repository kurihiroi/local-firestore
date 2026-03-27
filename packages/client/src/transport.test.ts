import { describe, expect, it, vi } from "vitest";
import { FirestoreError, HttpTransport } from "./transport.js";

describe("FirestoreError", () => {
  it("codeとmessageを保持する", () => {
    const error = new FirestoreError("not-found", "Document not found");
    expect(error.code).toBe("not-found");
    expect(error.message).toBe("Document not found");
    expect(error.name).toBe("FirestoreError");
  });

  it("Errorのインスタンスである", () => {
    const error = new FirestoreError("internal", "Internal error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FirestoreError);
  });

  it("異なるエラーコードを扱える", () => {
    const codes = [
      "cancelled",
      "unknown",
      "invalid-argument",
      "deadline-exceeded",
      "not-found",
      "already-exists",
      "permission-denied",
      "aborted",
      "unavailable",
    ] as const;
    for (const code of codes) {
      const error = new FirestoreError(code, `Error: ${code}`);
      expect(error.code).toBe(code);
    }
  });
});

describe("HttpTransport", () => {
  it("HTTP URLを正しく構築する", () => {
    const transport = new HttpTransport("localhost", 8080);
    expect(transport.getWebSocketUrl()).toBe("ws://localhost:8080");
  });

  it("SSL有効時にHTTPS/WSSを使用する", () => {
    const transport = new HttpTransport("example.com", 443, true);
    expect(transport.getWebSocketUrl()).toBe("wss://example.com:443");
  });

  it("get()がfetchを呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: "test" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    const result = await transport.get<{ data: string }>("/test");

    expect(result).toEqual({ data: "test" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/test");

    vi.unstubAllGlobals();
  });

  it("post()がfetchをPOSTメソッドで呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ id: "123" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    const result = await transport.post<{ id: string }>("/docs", { name: "Alice" });

    expect(result).toEqual({ id: "123" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });

    vi.unstubAllGlobals();
  });

  it("put()がfetchをPUTメソッドで呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    await transport.put("/docs/users/alice", { name: "Alice" });

    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });

    vi.unstubAllGlobals();
  });

  it("patch()がfetchをPATCHメソッドで呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    await transport.patch("/docs/users/alice", { age: 31 });

    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: 31 }),
    });

    vi.unstubAllGlobals();
  });

  it("delete()がfetchをDELETEメソッドで呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ success: true }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    const result = await transport.delete<{ success: boolean }>("/docs/users/alice");

    expect(result).toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "DELETE",
    });

    vi.unstubAllGlobals();
  });

  it("エラーレスポンスでFirestoreErrorをthrowする", async () => {
    const mockResponse = {
      ok: false,
      statusText: "Not Found",
      json: () => Promise.resolve({ code: "not-found", message: "Document not found" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);

    await expect(transport.get("/docs/users/nonexistent")).rejects.toThrow(FirestoreError);
    await expect(transport.get("/docs/users/nonexistent")).rejects.toThrow("Document not found");

    vi.unstubAllGlobals();
  });

  it("エラーレスポンスのJSON解析失敗時もFirestoreErrorをthrowする", async () => {
    const mockResponse = {
      ok: false,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("not json")),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);

    try {
      await transport.get("/error");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      const err = e as FirestoreError;
      expect(err.code).toBe("unknown");
      expect(err.message).toBe("Internal Server Error");
    }

    vi.unstubAllGlobals();
  });
});
