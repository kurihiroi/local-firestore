import { randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";

/**
 * オンラインバックアップ / WAL チェックポイントの管理ルート
 *
 * - POST /admin/api/backup
 *   SQLite の Online Backup API（`db.backup()`）でスナップショットを取得する。
 *   稼働中の書き込みと衝突せず、一貫性のあるバックアップファイルが得られる
 *   （稼働中のファイルコピーは WAL 併用時に整合性を壊しうるため使わないこと）。
 *   - body に `{ "path": "..." }` を指定するとサーバー側のそのパスへ書き出す
 *   - path 省略時はバックアップファイルの内容をレスポンスボディで返す
 *   - 暗号化データベース（DB_ENCRYPTION_KEY）のバックアップは同じ鍵で暗号化される
 *
 * - POST /admin/api/checkpoint
 *   `wal_checkpoint(TRUNCATE)` を実行して WAL の内容を DB 本体へ反映し、
 *   `-wal` ファイルを切り詰める（WAL 肥大の抑制）。
 */
export function createBackupRoutes(db: Database.Database): Hono {
  const app = new Hono();

  app.post("/admin/api/backup", async (c) => {
    let requestedPath: string | undefined;
    try {
      const body = await c.req.json<{ path?: string }>();
      requestedPath = typeof body?.path === "string" && body.path !== "" ? body.path : undefined;
    } catch {
      // ボディなし（ダウンロード形式）
    }

    // サーバー側パスへの書き出し
    if (requestedPath) {
      try {
        await db.backup(requestedPath);
        const sizeBytes = statSync(requestedPath).size;
        return c.json({ success: true, path: requestedPath, sizeBytes });
      } catch (err) {
        return c.json({ code: "internal", message: `Backup failed: ${String(err)}` }, 500);
      }
    }

    // path 省略時: 一時ファイルへバックアップしてレスポンスで返す
    const tempPath = join(tmpdir(), `local-firestore-backup-${randomBytes(8).toString("hex")}.db`);
    try {
      await db.backup(tempPath);
      const content = readFileSync(tempPath);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", 'attachment; filename="backup.db"');
      return c.body(new Uint8Array(content));
    } catch (err) {
      return c.json({ code: "internal", message: `Backup failed: ${String(err)}` }, 500);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // 一時ファイルが作られていない場合は無視
      }
    }
  });

  app.post("/admin/api/checkpoint", (c) => {
    const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = result[0] ?? { busy: 0, log: 0, checkpointed: 0 };
    return c.json({
      success: row.busy === 0,
      // busy: チェックポイントを完了できなかった場合 1
      busy: row.busy,
      // log: WAL 内の総フレーム数 / checkpointed: 反映済みフレーム数
      walFrames: row.log,
      checkpointedFrames: row.checkpointed,
    });
  });

  return app;
}
