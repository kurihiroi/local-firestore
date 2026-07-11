import type { VectorDistanceMeasure } from "@local-firestore/shared";
import { arrayContainsKey, computeFirestoreKey, pathOrderKey } from "@local-firestore/shared";
import Database from "better-sqlite3";
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { initSchema } from "./schema.js";

/** データベースファイルが現在の暗号化設定で読めないときのエラー */
export class DatabaseOpenError extends Error {
  constructor(path: string, hasEncryptionKey: boolean) {
    super(
      hasEncryptionKey
        ? `Failed to open database "${path}" with the provided DB_ENCRYPTION_KEY. ` +
            `The key is wrong, or the file is not encrypted. To encrypt an existing ` +
            `unencrypted database, export its data from a server running without ` +
            `DB_ENCRYPTION_KEY (GET /export), then import it into a fresh server ` +
            `started with DB_ENCRYPTION_KEY (POST /import).`
        : `Failed to open database "${path}". The file may be encrypted — ` +
            `if so, set DB_ENCRYPTION_KEY to the key it was created with.`,
    );
    this.name = "DatabaseOpenError";
  }
}

export interface CreateDatabaseOptions {
  /**
   * at-rest 暗号化キー（`DB_ENCRYPTION_KEY`）。指定時は better-sqlite3-multiple-ciphers
   * で暗号化データベースとして開く。`:memory:` データベースでは無視される
   * （永続化されないため暗号化対象がない）。
   */
  encryptionKey?: string;
}

export function createDatabase(
  path: string = ":memory:",
  options: CreateDatabaseOptions = {},
): Database.Database {
  const encryptionKey = path === ":memory:" ? undefined : options.encryptionKey;

  // better-sqlite3-multiple-ciphers は better-sqlite3 と API 互換
  const db: Database.Database = encryptionKey ? new CipherDatabase(path) : new Database(path);

  if (encryptionKey) {
    // key プラグマは他のあらゆる操作より先に実行する必要がある
    // （SQL 文字列リテラルとして埋め込むため ' をエスケープ）
    db.pragma(`key='${encryptionKey.replace(/'/g, "''")}'`);
  }

  try {
    // 最初のファイルアクセスで鍵の正誤・暗号化有無の不一致を検出する
    db.pragma("journal_mode = WAL");
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_NOTADB") {
      throw new DatabaseOpenError(path, encryptionKey !== undefined);
    }
    throw err;
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  initSchema(db);
  registerVectorFunctions(db);
  registerFirestoreKeyFunctions(db);

  return db;
}

/**
 * Firestore 互換の比較セマンティクス用ユーザー定義関数を登録する
 *
 * - firestore_key(json) -> string | null
 *   JSON 値（`data -> '$.field'` の出力）を Firestore の値順序を保存するキーに変換する。
 *   フィールド欠損（SQL NULL）の場合は NULL を返し、比較・ソート対象から除外される。
 * - firestore_path_key(path) -> string | null
 *   ドキュメントパスを完全リソース名のセグメント順を保存するキーに変換する
 *   （`__name__` の ORDER BY / カーソル比較用。生の path 文字列比較では
 *   "/" より小さい文字を含む ID で本家と順序が食い違う）。
 * - firestore_arr_contains(json, elementKey) -> 0 | 1
 * - firestore_arr_contains_any(json, elementKeysJson) -> 0 | 1
 */
function registerFirestoreKeyFunctions(db: Database.Database): void {
  db.function("firestore_key", { deterministic: true }, (json: unknown): string | null => {
    if (json === null || json === undefined) return null;
    return computeFirestoreKey(String(json));
  });

  db.function("firestore_path_key", { deterministic: true }, (path: unknown): string | null => {
    if (typeof path !== "string") return null;
    return pathOrderKey(path);
  });

  db.function(
    "firestore_arr_contains",
    { deterministic: true },
    (json: unknown, elementKey: unknown): number => {
      if (typeof elementKey !== "string") return 0;
      return arrayContainsKey(json === null ? null : String(json), elementKey) ? 1 : 0;
    },
  );

  db.function(
    "firestore_arr_contains_any",
    { deterministic: true },
    (json: unknown, elementKeysJson: unknown): number => {
      if (typeof elementKeysJson !== "string") return 0;
      let keys: unknown;
      try {
        keys = JSON.parse(elementKeysJson);
      } catch {
        return 0;
      }
      if (!Array.isArray(keys)) return 0;
      const jsonStr = json === null || json === undefined ? null : String(json);
      return keys.some((k) => typeof k === "string" && arrayContainsKey(jsonStr, k)) ? 1 : 0;
    },
  );
}

/** JSON文字列を数値ベクトルとしてパースする。無効な場合は null */
function parseVector(json: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((v): v is number => typeof v === "number" && Number.isFinite(v))) return null;
  return parsed;
}

/**
 * ベクトル距離計算のユーザー定義関数を登録する
 *
 * vector_distance(fieldJson, queryVectorJson, measure) -> number | null
 * - fieldJson: ドキュメント側のベクトル（JSON配列文字列）
 * - queryVectorJson: クエリベクトル（JSON配列文字列）
 * - measure: "EUCLIDEAN" | "COSINE" | "DOT_PRODUCT"
 *
 * ベクトルが無効・次元不一致の場合は null を返す（該当ドキュメントは検索対象外）。
 */
function registerVectorFunctions(db: Database.Database): void {
  db.function(
    "vector_distance",
    { deterministic: true },
    (fieldJson: unknown, queryVectorJson: unknown, measure: unknown): number | null => {
      if (typeof fieldJson !== "string" || typeof queryVectorJson !== "string") return null;
      const target = parseVector(fieldJson);
      const query = parseVector(queryVectorJson);
      if (!target || !query || target.length !== query.length) return null;
      return computeDistance(target, query, measure as VectorDistanceMeasure);
    },
  );
}

function computeDistance(a: number[], b: number[], measure: VectorDistanceMeasure): number | null {
  switch (measure) {
    case "EUCLIDEAN": {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.sqrt(sum);
    }
    case "COSINE": {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      if (normA === 0 || normB === 0) return null;
      return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    case "DOT_PRODUCT": {
      let dot = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
      }
      return dot;
    }
    default:
      return null;
  }
}
