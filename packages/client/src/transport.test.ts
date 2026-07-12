import { afterEach, describe, expect, it, vi } from "vitest";
import { FirebaseError, FirestoreError, HttpTransport, isTransientError } from "./transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FirestoreError", () => {
  it("codeとmessageを保持する", () => {
    const error = new FirestoreError("not-found", "Document not found");
    expect(error.code).toBe("not-found");
    expect(error.message).toBe("Document not found");
    // 本家同様 name は "FirebaseError"
    expect(error.name).toBe("FirebaseError");
  });

  it("Error / FirebaseError のインスタンスである（本家互換）", () => {
    const error = new FirestoreError("internal", "Internal error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FirebaseError);
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

describe("isTransientError", () => {
  it("unavailable / deadline-exceeded を一過性と判定する", () => {
    expect(isTransientError(new FirestoreError("unavailable", "down"))).toBe(true);
    expect(isTransientError(new FirestoreError("deadline-exceeded", "slow"))).toBe(true);
  });

  it("その他のコードや FirestoreError 以外は一過性でない", () => {
    expect(isTransientError(new FirestoreError("not-found", "missing"))).toBe(false);
    expect(isTransientError(new FirestoreError("permission-denied", "denied"))).toBe(false);
    expect(isTransientError(new Error("boom"))).toBe(false);
    expect(isTransientError("unavailable")).toBe(false);
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
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/test", {
      method: "GET",
      headers: {},
      signal: expect.any(AbortSignal),
    });
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
      signal: expect.any(AbortSignal),
    });
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
      signal: expect.any(AbortSignal),
    });
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
      signal: expect.any(AbortSignal),
    });
  });

  it("delete()がfetchをDELETEメソッドで呼び出す", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ success: true }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);
    const result = await transport.delete<{ success: boolean }>("/docs/users/alice");

    expect(result).toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "DELETE",
      headers: {},
      signal: expect.any(AbortSignal),
    });
  });

  it("エラーレスポンスでFirestoreErrorをthrowする", async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: () => Promise.resolve({ code: "not-found", message: "Document not found" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080);

    await expect(transport.get("/docs/users/nonexistent")).rejects.toThrow(FirestoreError);
    await expect(transport.get("/docs/users/nonexistent")).rejects.toThrow("Document not found");
  });

  it("エラーレスポンスのJSON解析失敗時もFirestoreErrorをthrowする", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
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
  });
});

describe("HttpTransport リトライ・タイムアウト", () => {
  const fastRetry = { initialDelayMs: 1, maxDelayMs: 2 };

  it("一過性エラー（unavailable）はリトライして成功する", async () => {
    const failResponse = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.resolve({ code: "unavailable", message: "server down" }),
    };
    const okResponse = { ok: true, json: () => Promise.resolve({ data: "ok" }) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(failResponse).mockResolvedValue(okResponse),
    );

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, fastRetry);
    const result = await transport.get<{ data: string }>("/test");

    expect(result).toEqual({ data: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ネットワークエラーは unavailable に正規化され、リトライ上限まで再試行する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, {
      ...fastRetry,
      maxAttempts: 3,
    });

    try {
      await transport.get("/test");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("unavailable");
      expect((e as FirestoreError).message).toContain("fetch failed");
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("非一過性エラー（invalid-argument）はリトライしない", async () => {
    const failResponse = {
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.resolve({ code: "invalid-argument", message: "bad data" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, fastRetry);

    await expect(transport.post("/docs", {})).rejects.toThrow("bad data");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("タイムアウトで deadline-exceeded を throw する", async () => {
    // abort シグナルを受けるまで解決しない fetch
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, {
      requestTimeoutMs: 5,
      maxAttempts: 1,
    });

    try {
      await transport.get("/slow");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("deadline-exceeded");
    }
  });

  it("code のないエラーレスポンスは HTTP ステータスからコードを補完する", async () => {
    const failResponse = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.reject(new Error("not json")),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, {
      ...fastRetry,
      maxAttempts: 2,
    });

    try {
      await transport.get("/test");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as FirestoreError).code).toBe("unavailable");
    }
    // unavailable と判定されるためリトライされる
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("post() の retry: false でトランスポート層のリトライを無効化できる", async () => {
    const failResponse = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.resolve({ code: "unavailable", message: "server down" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", undefined, fastRetry);

    await expect(transport.post("/transaction/commit", {}, { retry: false })).rejects.toThrow(
      "server down",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport basePath（マルチデータベース）", () => {
  it("basePathが全リクエストURLにプレフィックスとして付与される", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080, false, "/databases/mydb");
    await transport.get("/docs/users/alice");

    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/databases/mydb/docs/users/alice", {
      method: "GET",
      headers: {},
      signal: expect.any(AbortSignal),
    });
  });

  it("basePath指定時もWebSocket URLにはプレフィックスが付かない", () => {
    const transport = new HttpTransport("localhost", 8080, false, "/databases/mydb");
    expect(transport.getWebSocketUrl()).toBe("ws://localhost:8080");
    expect(transport.getBaseUrl()).toBe("http://localhost:8080/databases/mydb");
  });
});

describe("HttpTransport 認証トークン", () => {
  it("authTokenProvider のトークンが Authorization ヘッダーで送信される", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", () => "my-id-token");
    await transport.get("/docs/users/alice");
    await transport.post("/query", {});

    expect(fetch).toHaveBeenNthCalledWith(1, "http://localhost:8080/docs/users/alice", {
      method: "GET",
      headers: { Authorization: "Bearer my-id-token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:8080/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer my-id-token",
      },
      body: JSON.stringify({}),
      signal: expect.any(AbortSignal),
    });
  });

  it("非同期の authTokenProvider も使用できる", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", async () => "async-token");
    await transport.delete("/docs/users/alice");

    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "DELETE",
      headers: { Authorization: "Bearer async-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("トークンが null の場合はヘッダーを付与しない", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const transport = new HttpTransport("localhost", 8080, false, "", () => null);
    await transport.get("/docs/users/alice");

    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/docs/users/alice", {
      method: "GET",
      headers: {},
      signal: expect.any(AbortSignal),
    });
  });
});
