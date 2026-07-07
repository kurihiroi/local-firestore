import type { DocumentData } from "@local-firestore/shared";
import type Database from "better-sqlite3";
import { normalizeLegacyDocumentData } from "./normalize.js";

/** migrate 実行結果のレポート */
export interface MigrationReport {
  /** 走査したドキュメント数 */
  scanned: number;
  /** データを書き換えたドキュメント数 */
  updated: number;
  /** 素の {seconds, nanoseconds} マップから変換した Timestamp 数 */
  timestampsConverted: number;
  /** マイクロ秒精度へ切り捨てた Timestamp 数 */
  nanosecondsTruncated: number;
  /**
   * 旧 deleteField 文字列（$$__DELETE__$$）が残存しているフィールド。
   * 意図したデータかセンチネル残存かを判別できないため自動変換はせず、
   * レポートのみ行う（必要に応じて手動で修正する）。
   */
  legacyDeleteMarkers: Array<{ path: string; field: string }>;
}

export interface MigrateOptions {
  /** true の場合、書き換えを行わずレポートのみ生成する */
  dryRun?: boolean;
}

/**
 * SQLite ファイル内の全ドキュメントを走査し、旧形式データを現行形式へ変換する。
 *
 * - 2026-07-04 以前のクライアント書き込みで保存された素の {seconds, nanoseconds}
 *   マップを {__type: "timestamp"} 形式へ変換する
 * - Timestamp のナノ秒をマイクロ秒精度へ切り捨てる（本家仕様）
 * - 旧 deleteField 文字列の残存を検出してレポートする
 *
 * ドキュメントの version / createTime / updateTime は変更しない
 * （データ表現の正規化であり、ユーザーによる更新ではないため）。
 */
export function migrateDatabase(db: Database.Database, options?: MigrateOptions): MigrationReport {
  const report: MigrationReport = {
    scanned: 0,
    updated: 0,
    timestampsConverted: 0,
    nanosecondsTruncated: 0,
    legacyDeleteMarkers: [],
  };

  const rows = db.prepare("SELECT path, data FROM documents ORDER BY path").all() as Array<{
    path: string;
    data: string;
  }>;
  const updateStmt = db.prepare("UPDATE documents SET data = ? WHERE path = ?");

  const run = db.transaction(() => {
    for (const row of rows) {
      report.scanned++;
      let data: DocumentData;
      try {
        data = JSON.parse(row.data) as DocumentData;
      } catch {
        continue; // 壊れた行はスキップ（通常発生しない）
      }

      const { data: normalized, stats } = normalizeLegacyDocumentData(data);
      report.timestampsConverted += stats.timestampsConverted;
      report.nanosecondsTruncated += stats.nanosecondsTruncated;
      for (const field of stats.legacyDeleteMarkerFields) {
        report.legacyDeleteMarkers.push({ path: row.path, field });
      }

      if (normalized !== data) {
        report.updated++;
        if (!options?.dryRun) {
          updateStmt.run(JSON.stringify(normalized), row.path);
        }
      }
    }
  });
  run();

  return report;
}
