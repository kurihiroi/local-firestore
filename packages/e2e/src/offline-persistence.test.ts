import {
  type CacheStorageLike,
  disableNetwork,
  doc,
  getDoc,
  getDocFromCache,
  getFirestore,
  persistentLocalCache,
  setDoc,
  terminate,
  waitForPendingWrites,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

/** Map ベースの Web Storage 互換フェイク（リロードをまたぐ localStorage の代替） */
function createFakeStorage(): CacheStorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("E2E: 永続キャッシュ（persistentLocalCache）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("オフライン書き込みが「リロード」をまたいで復元され、自動送信される", async () => {
    const storage = createFakeStorage();

    // セッション1: オフラインで書き込み → terminate（ページリロード想定）
    const db1 = getFirestore({
      host: "localhost",
      port: ctx.port,
      localCache: persistentLocalCache({ storage }),
    });
    await disableNetwork(db1);
    void setDoc(doc(db1, "drafts/d1"), { title: "offline write" }).catch(() => {});
    // ローカルビューへは即時反映されている
    const cached1 = await getDocFromCache(doc(db1, "drafts/d1"));
    expect(cached1.data()).toEqual({ title: "offline write" });
    await terminate(db1);

    // サーバーにはまだ届いていない
    const serverRes = await fetch(`http://localhost:${ctx.port}/docs/drafts/d1`);
    expect(((await serverRes.json()) as { exists: boolean }).exists).toBe(false);

    // セッション2: 同じストレージから復元 → 保留書き込みが自動送信される
    const db2 = getFirestore({
      host: "localhost",
      port: ctx.port,
      localCache: persistentLocalCache({ storage }),
    });
    const restored = await getDocFromCache(doc(db2, "drafts/d1"));
    expect(restored.exists()).toBe(true);
    expect(restored.data()).toEqual({ title: "offline write" });
    expect(restored.metadata.hasPendingWrites).toBe(true);

    await vi.waitFor(async () => {
      const res = await fetch(`http://localhost:${ctx.port}/docs/drafts/d1`);
      const body = (await res.json()) as { exists: boolean };
      expect(body.exists).toBe(true);
    });
    await terminate(db2);
  });

  it("サーバー確定スナップショットのキャッシュも復元される", async () => {
    const storage = createFakeStorage();

    const db1 = getFirestore({
      host: "localhost",
      port: ctx.port,
      localCache: persistentLocalCache({ storage }),
    });
    await setDoc(doc(db1, "notes/n1"), { body: "hello" });
    await waitForPendingWrites(db1);
    // getDoc でサーバー確定値をキャッシュに載せる
    await getDoc(doc(db1, "notes/n1"));
    await terminate(db1);

    const db2 = getFirestore({
      host: "localhost",
      port: ctx.port,
      localCache: persistentLocalCache({ storage }),
    });
    const restored = await getDocFromCache(doc(db2, "notes/n1"));
    expect(restored.exists()).toBe(true);
    expect(restored.data()).toEqual({ body: "hello" });
    await terminate(db2);
  });

  it("terminate 後の操作は failed-precondition で拒否される", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    await terminate(db);
    await expect(getDoc(doc(db, "any/x"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });
});
