import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../storage/sqlite.js";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Backup / Checkpoint Routes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lf-backup-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("POST /admin/api/backup", () => {
    it("path 指定でサーバー側パスへオンラインバックアップを書き出す", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/alice", { data: { name: "Alice" } });
      await request(app, "PUT", "/docs/users/bob", { data: { name: "Bob" } });

      const backupPath = join(tempDir, "backup.db");
      const res = await request(app, "POST", "/admin/api/backup", { path: backupPath });
      expect(res.status).toBe(200);

      const body = await jsonBody<{ success: boolean; path: string; sizeBytes: number }>(res);
      expect(body.success).toBe(true);
      expect(body.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(backupPath)).toBe(true);

      // バックアップファイルを開いて内容を検証できる
      const restored = createDatabase(backupPath);
      const rows = restored.prepare("SELECT path FROM documents ORDER BY path").all() as Array<{
        path: string;
      }>;
      restored.close();
      expect(rows.map((r) => r.path)).toEqual(["users/alice", "users/bob"]);
    });

    it("path 省略時はバックアップ内容をレスポンスボディで返す", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/alice", { data: { name: "Alice" } });

      const res = await request(app, "POST", "/admin/api/backup");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/octet-stream");

      // 返されたバイト列は SQLite データベースとして開ける
      const content = Buffer.from(await res.arrayBuffer());
      expect(content.length).toBeGreaterThan(0);
      const downloadedPath = join(tempDir, "downloaded.db");
      writeFileSync(downloadedPath, content);
      const restored = createDatabase(downloadedPath);
      const count = restored.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
      restored.close();
      expect(count.n).toBe(1);
    });

    it("書き込み不能なパスへのバックアップは 500 を返す", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/admin/api/backup", {
        path: join(tempDir, "no-such-dir", "backup.db"),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe("internal");
    });
  });

  describe("POST /admin/api/checkpoint", () => {
    it("wal_checkpoint(TRUNCATE) を実行して結果を返す", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/alice", { data: { name: "Alice" } });

      const res = await request(app, "POST", "/admin/api/checkpoint");
      expect(res.status).toBe(200);
      const body = await jsonBody<{
        success: boolean;
        busy: number;
        walFrames: number;
        checkpointedFrames: number;
      }>(res);
      expect(body.success).toBe(true);
      expect(body.busy).toBe(0);
    });
  });
});
