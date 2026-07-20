import type { SerializedQueryConstraint } from "@local-firestore/shared";
import { applyQueryConstraints } from "@local-firestore/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { QueryService } from "./query.js";

/**
 * shared のローカルクエリ評価（query-matcher）とサーバーの SQLite 実装
 * （QueryService + firestore_key UDF）が同一の結果（内容・順序）を返すことを
 * 同一フィクスチャで検証するパリティテスト。
 *
 * クライアントのレイテンシ補償はローカル評価に依存するため、両者の乖離は
 * 「ローカル反映とサーバー確定後で結果が変わる」バグに直結する。
 */

function ts(seconds: number, nanoseconds = 0) {
  return { __type: "timestamp", value: { seconds, nanoseconds } };
}

/** フィクスチャ: 型・欠損・ネスト・特殊値を含むドキュメント集合 */
const FIXTURE_DOCS: Array<{ path: string; data: Record<string, unknown> }> = [
  { path: "items/a", data: { n: 1, s: "apple", tags: ["red", "fruit"], at: ts(100) } },
  { path: "items/b", data: { n: 2.5, s: "banana", tags: ["yellow", "fruit"], at: ts(200) } },
  { path: "items/c", data: { n: -3, s: "cherry", tags: ["red"], at: ts(150, 500_000) } },
  { path: "items/d", data: { n: 2.5, s: "date", nested: { rank: 1 } } }, // tags / at 欠損
  { path: "items/e", data: { n: null, s: "elderberry", tags: [] } },
  { path: "items/f", data: { s: "fig", flag: true, nested: { rank: 2 } } }, // n 欠損
  { path: "items/g", data: { n: { __type: "double", value: "NaN" }, s: "grape" } },
  {
    path: "items/h",
    data: { n: 0, s: "拉麺", geo: { __type: "geopoint", value: { latitude: 35, longitude: 139 } } },
  },
  // コレクショングループ用
  { path: "shelf/s1/items/x", data: { n: 10, s: "xigua" } },
  { path: "shelf/s2/items/y", data: { n: -10, s: "yuzu" } },
  { path: "shelf/s1/other/z", data: { n: 999 } },
  // "/" より小さい文字（"-"）を含む親 ID: 生パス比較とセグメント順が食い違うケース
  { path: "shelf/s/items/v", data: { n: 5, s: "vanilla" } },
  { path: "shelf/s-1/items/w", data: { n: 6, s: "wasabi" } },
  // 特殊文字を含むフィールド名（バッククォートエスケープの対象）
  { path: "items/i", data: { n: 7, s: "ichigo", "pri-ce": 100, "a.b": "literal" } },
  // UTF-8 バイト順検証用（#39: サロゲートペア vs U+E000〜U+FFFF）
  { path: "unicode/a", data: { s: "\uE000", m: { "\uE000": 1, "\u{1F600}": 2 } } },
  { path: "unicode/b", data: { s: "\u{1F600}", m: { "\uE000": 1, "\u{1F600}": 3 } } },
  { path: "unicode/c", data: { s: "\uFFFD", m: { "\uE000": 0, "\u{1F600}": 9 } } },
  { path: "unicode/d", data: { s: "あいう" } },
  // astral 文字を含むドキュメントID（__name__ タイブレーク順の検証）
  { path: "unicode/\uE000", data: { s: "id-bmp" } },
  { path: "unicode/\u{1F600}", data: { s: "id-astral" } },
];

/** フィクスチャ: 代表的なクエリ制約の組合せ */
const FIXTURE_QUERIES: Array<{
  name: string;
  collectionPath: string;
  collectionGroup?: boolean;
  constraints: SerializedQueryConstraint[];
}> = [
  { name: "フィルタなし", collectionPath: "items", constraints: [] },
  {
    name: "== 数値",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: "==", value: 2.5 }],
  },
  {
    name: "== null",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: "==", value: null }],
  },
  {
    name: "== NaN",
    collectionPath: "items",
    constraints: [
      { type: "where", fieldPath: "n", op: "==", value: { __type: "double", value: "NaN" } },
    ],
  },
  {
    name: "!=（null・欠損除外）",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: "!=", value: 2.5 }],
  },
  {
    name: "範囲 >（型ブラケット・暗黙ソート）",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: ">", value: 0 }],
  },
  {
    name: "範囲 <=（NaN は数値の最小）",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: "<=", value: 1 }],
  },
  {
    name: "Timestamp 範囲",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "at", op: ">=", value: ts(150, 500_000) }],
  },
  {
    name: "array-contains",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "tags", op: "array-contains", value: "red" }],
  },
  {
    name: "array-contains-any",
    collectionPath: "items",
    constraints: [
      { type: "where", fieldPath: "tags", op: "array-contains-any", value: ["yellow", "fruit"] },
    ],
  },
  {
    name: "in",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "s", op: "in", value: ["apple", "fig", "none"] }],
  },
  {
    name: "not-in",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "n", op: "not-in", value: [1, 2.5] }],
  },
  {
    name: "ネストフィールド",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "nested.rank", op: ">=", value: 1 }],
  },
  {
    name: "orderBy asc（欠損除外・__name__ タイブレーク）",
    collectionPath: "items",
    constraints: [{ type: "orderBy", fieldPath: "n", direction: "asc" }],
  },
  {
    name: "orderBy desc",
    collectionPath: "items",
    constraints: [{ type: "orderBy", fieldPath: "n", direction: "desc" }],
  },
  {
    name: "orderBy 複数",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "orderBy", fieldPath: "s", direction: "desc" },
    ],
  },
  {
    name: "orderBy + limit",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "limit", limit: 3 },
    ],
  },
  {
    name: "orderBy + limitToLast",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "limitToLast", limit: 3 },
    ],
  },
  {
    name: "orderBy + startAfter",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "startAfter", values: [0] },
    ],
  },
  {
    name: "orderBy + startAt + endBefore",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "startAt", values: [-3] },
      { type: "endBefore", values: [2.5] },
    ],
  },
  {
    name: "orderBy 複数 + カーソル（辞書式タプル）",
    collectionPath: "items",
    constraints: [
      { type: "orderBy", fieldPath: "n", direction: "asc" },
      { type: "orderBy", fieldPath: "s", direction: "asc" },
      { type: "startAfter", values: [2.5, "banana"] },
    ],
  },
  {
    name: "__name__ カーソル（相対ID正規化）",
    collectionPath: "items",
    constraints: [{ type: "startAfter", values: ["c"] }],
  },
  {
    name: "and 複合",
    collectionPath: "items",
    constraints: [
      {
        type: "and",
        filters: [
          { type: "where", fieldPath: "tags", op: "array-contains", value: "fruit" },
          { type: "where", fieldPath: "n", op: ">", value: 1 },
        ],
      },
    ],
  },
  {
    name: "or 複合",
    collectionPath: "items",
    constraints: [
      {
        type: "or",
        filters: [
          { type: "where", fieldPath: "s", op: "==", value: "apple" },
          { type: "where", fieldPath: "flag", op: "==", value: true },
        ],
      },
    ],
  },
  {
    name: "バッククォートフィールドパス（ダッシュ / リテラルドット）",
    collectionPath: "items",
    constraints: [
      { type: "where", fieldPath: "`pri-ce`", op: "==", value: 100 },
      { type: "where", fieldPath: "`a.b`", op: "==", value: "literal" },
    ],
  },
  {
    name: "__name__ == フィルタ",
    collectionPath: "items",
    constraints: [{ type: "where", fieldPath: "__name__", op: "==", value: "b" }],
  },
  {
    name: "__name__ 範囲フィルタ（>= / <、相対ID正規化）",
    collectionPath: "items",
    constraints: [
      { type: "where", fieldPath: "__name__", op: ">=", value: "b" },
      { type: "where", fieldPath: "__name__", op: "<", value: "f" },
    ],
  },
  {
    name: "コレクショングループ + __name__ 範囲フィルタ（フルパス）",
    collectionPath: "items",
    collectionGroup: true,
    constraints: [{ type: "where", fieldPath: "__name__", op: ">", value: "shelf/s1/items/x" }],
  },
  { name: "コレクショングループ", collectionPath: "items", collectionGroup: true, constraints: [] },
  {
    name: "コレクショングループ + orderBy",
    collectionPath: "items",
    collectionGroup: true,
    constraints: [{ type: "orderBy", fieldPath: "n", direction: "desc" }],
  },
  {
    name: "コレクショングループ + __name__ カーソル（セグメント順）",
    collectionPath: "items",
    collectionGroup: true,
    constraints: [{ type: "startAfter", values: ["shelf/s/items/v"] }],
  },
  {
    name: "UTF-8 順: orderBy 文字列（astral vs BMP）",
    collectionPath: "unicode",
    constraints: [{ type: "orderBy", fieldPath: "s", direction: "asc" }],
  },
  {
    name: "UTF-8 順: 文字列範囲フィルタ",
    collectionPath: "unicode",
    constraints: [{ type: "where", fieldPath: "s", op: ">", value: "\uE000" }],
  },
  {
    name: "UTF-8 順: カーソル（BMP 末尾の次が astral）",
    collectionPath: "unicode",
    constraints: [
      { type: "orderBy", fieldPath: "s", direction: "asc" },
      { type: "startAfter", values: ["\uFFFD"] },
    ],
  },
  {
    name: "UTF-8 順: astral ドキュメントID の __name__ 順",
    collectionPath: "unicode",
    constraints: [],
  },
  {
    name: "UTF-8 順: マップ値の orderBy（キー順が影響）",
    collectionPath: "unicode",
    constraints: [{ type: "orderBy", fieldPath: "m", direction: "asc" }],
  },
];

describe("query-matcher と QueryService のパリティ", () => {
  let queryService: QueryService;

  beforeAll(() => {
    const db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    const docService = new DocumentService(repo);
    queryService = new QueryService(db);
    for (const d of FIXTURE_DOCS) {
      docService.setDocument(d.path, d.data);
    }
  });

  for (const q of FIXTURE_QUERIES) {
    it(q.name, () => {
      const serverResults = queryService
        .executeQuery(q.collectionPath, q.constraints, q.collectionGroup ?? false)
        .map((r) => r.path);
      const localResults = applyQueryConstraints(
        FIXTURE_DOCS,
        q.collectionPath,
        q.collectionGroup ?? false,
        q.constraints,
      ).map((r) => r.path);

      expect(localResults).toEqual(serverResults);
    });
  }

  // パリティ（server == client）に加え、本家の UTF-8 バイト順そのものを固定する
  describe("本家準拠の期待順序（UTF-8 バイト順）", () => {
    it("orderBy 文字列: ASCII → CJK → U+E000 → U+FFFD → astral の順", () => {
      const results = queryService
        .executeQuery("unicode", [{ type: "orderBy", fieldPath: "s", direction: "asc" }], false)
        .map((r) => r.path);
      expect(results).toEqual([
        "unicode/\u{1F600}", // s: "id-astral"
        "unicode/\uE000", // s: "id-bmp"
        "unicode/d", // s: "あいう"
        "unicode/a", // s: "\uE000"
        "unicode/c", // s: "\uFFFD"
        "unicode/b", // s: "\u{1F600}"（astral は BMP より後）
      ]);
    });

    it("__name__ 順: astral ドキュメントID は BMP の ID より後", () => {
      const results = queryService.executeQuery("unicode", [], false).map((r) => r.path);
      expect(results).toEqual([
        "unicode/a",
        "unicode/b",
        "unicode/c",
        "unicode/d",
        "unicode/\uE000",
        "unicode/\u{1F600}",
      ]);
    });
  });
});
