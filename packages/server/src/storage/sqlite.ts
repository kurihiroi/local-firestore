import type { VectorDistanceMeasure } from "@local-firestore/shared";
import Database from "better-sqlite3";
import { arrayContainsKey, computeFirestoreKey } from "./firestore-key.js";
import { initSchema } from "./schema.js";

export function createDatabase(path: string = ":memory:"): Database.Database {
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
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
 * - firestore_arr_contains(json, elementKey) -> 0 | 1
 * - firestore_arr_contains_any(json, elementKeysJson) -> 0 | 1
 */
function registerFirestoreKeyFunctions(db: Database.Database): void {
  db.function("firestore_key", { deterministic: true }, (json: unknown): string | null => {
    if (json === null || json === undefined) return null;
    return computeFirestoreKey(String(json));
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
