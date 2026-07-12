import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { QueryService, QueryValidationError } from "./query.js";

describe("QueryService", () => {
  let db: Database.Database;
  let docService: DocumentService;
  let queryService: QueryService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    docService = new DocumentService(repo);
    queryService = new QueryService(db);

    // テストデータ投入
    docService.setDocument("users/alice", {
      name: "Alice",
      age: 30,
      status: "active",
      tags: ["ts", "node"],
    });
    docService.setDocument("users/bob", {
      name: "Bob",
      age: 25,
      status: "inactive",
      tags: ["python"],
    });
    docService.setDocument("users/charlie", {
      name: "Charlie",
      age: 35,
      status: "active",
      tags: ["ts", "go"],
    });
    docService.setDocument("users/dave", {
      name: "Dave",
      age: 28,
      status: "active",
      tags: ["node", "rust"],
    });
  });

  describe("基本クエリ", () => {
    it("コレクション内の全ドキュメントを取得できる", () => {
      const results = queryService.executeQuery("users", []);
      expect(results).toHaveLength(4);
    });

    it("空のコレクションは空配列を返す", () => {
      const results = queryService.executeQuery("posts", []);
      expect(results).toHaveLength(0);
    });
  });

  describe("whereフィルタ", () => {
    it("== フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "==", value: "active" },
      ]);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie", "dave"]);
    });

    describe("__name__ (documentId) フィルタ", () => {
      it("== でドキュメントIDによる絞り込みができる", () => {
        const results = queryService.executeQuery("users", [
          { type: "where", fieldPath: "__name__", op: "==", value: "alice" },
        ]);
        expect(results).toHaveLength(1);
        expect(results[0].documentId).toBe("alice");
      });

      it("!= でドキュメントIDを除外できる", () => {
        const results = queryService.executeQuery("users", [
          { type: "where", fieldPath: "__name__", op: "!=", value: "alice" },
        ]);
        expect(results.map((r) => r.documentId).sort()).toEqual(["bob", "charlie", "dave"]);
      });

      it("in で複数のドキュメントIDを指定できる", () => {
        const results = queryService.executeQuery("users", [
          { type: "where", fieldPath: "__name__", op: "in", value: ["alice", "bob"] },
        ]);
        expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "bob"]);
      });

      it("not-in で複数のドキュメントIDを除外できる", () => {
        const results = queryService.executeQuery("users", [
          { type: "where", fieldPath: "__name__", op: "not-in", value: ["alice", "bob"] },
        ]);
        expect(results.map((r) => r.documentId).sort()).toEqual(["charlie", "dave"]);
      });

      it("他フィールドの where と組み合わせられる", () => {
        const results = queryService.executeQuery("users", [
          { type: "where", fieldPath: "status", op: "==", value: "active" },
          { type: "where", fieldPath: "__name__", op: "in", value: ["alice", "bob"] },
        ]);
        expect(results.map((r) => r.documentId)).toEqual(["alice"]);
      });

      it("未対応の演算子はエラーになる", () => {
        expect(() =>
          queryService.executeQuery("users", [
            { type: "where", fieldPath: "__name__", op: ">", value: "alice" },
          ]),
        ).toThrow("Unsupported operator for documentId()");
      });
    });

    it("!= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "!=", value: "active" },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("bob");
    });

    it("> フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: ">", value: 28 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });

    it(">= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: ">=", value: 30 },
      ]);
      expect(results).toHaveLength(2);
    });

    it("< フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: "<", value: 28 },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("bob");
    });

    it("<= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: "<=", value: 28 },
      ]);
      expect(results).toHaveLength(2);
    });

    it("in フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "name", op: "in", value: ["Alice", "Bob"] },
      ]);
      expect(results).toHaveLength(2);
    });

    it("not-in フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "name", op: "not-in", value: ["Alice", "Bob"] },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["charlie", "dave"]);
    });

    it("array-contains フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "tags", op: "array-contains", value: "ts" },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });

    it("array-contains-any フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "tags", op: "array-contains-any", value: ["python", "rust"] },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["bob", "dave"]);
    });

    it("複数のwhereフィルタを組み合わせられる", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "==", value: "active" },
        { type: "where", fieldPath: "age", op: ">=", value: 30 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });
  });

  describe("orderBy", () => {
    it("昇順ソート", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave", "alice", "charlie"]);
    });

    it("降順ソート", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "desc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["charlie", "alice", "dave", "bob"]);
    });
  });

  describe("limit", () => {
    it("limit で件数制限できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "limit", limit: 2 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("limitToLast で末尾から取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "limitToLast", limit: 2 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });
  });

  describe("カーソル", () => {
    it("startAt で指定値以降を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAt", values: [30] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });

    it("startAfter で指定値より後を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAfter", values: [28] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });

    it("endAt で指定値以前を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "endAt", values: [28] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("endBefore で指定値より前を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "endBefore", values: [30] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("startAfter + endBefore で範囲指定できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAfter", values: [25] },
        { type: "endBefore", values: [35] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["dave", "alice"]);
    });
  });

  describe("複合フィルタ", () => {
    it("AND複合フィルタ", () => {
      const results = queryService.executeQuery("users", [
        {
          type: "and",
          filters: [
            { type: "where", fieldPath: "status", op: "==", value: "active" },
            { type: "where", fieldPath: "age", op: "<", value: 30 },
          ],
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("dave");
    });

    it("OR複合フィルタ", () => {
      const results = queryService.executeQuery("users", [
        {
          type: "or",
          filters: [
            { type: "where", fieldPath: "age", op: "==", value: 25 },
            { type: "where", fieldPath: "age", op: "==", value: 35 },
          ],
        },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["bob", "charlie"]);
    });
  });

  describe("コレクショングループクエリ", () => {
    beforeEach(() => {
      docService.setDocument("users/alice/posts/post1", { title: "Hello", likes: 10 });
      docService.setDocument("users/bob/posts/post2", { title: "World", likes: 5 });
      docService.setDocument("groups/dev/posts/post3", { title: "Dev", likes: 20 });
    });

    it("全サブコレクションからドキュメントを取得できる", () => {
      const results = queryService.executeQuery("posts", [], true);
      expect(results).toHaveLength(3);
    });

    it("コレクショングループクエリにwhereフィルタを適用できる", () => {
      const results = queryService.executeQuery(
        "posts",
        [{ type: "where", fieldPath: "likes", op: ">=", value: 10 }],
        true,
      );
      expect(results).toHaveLength(2);
    });

    it("結果は完全リソース名（セグメント単位）順に並ぶ", () => {
      const results = queryService.executeQuery("posts", [], true);
      expect(results.map((r) => r.path)).toEqual([
        "groups/dev/posts/post3",
        "users/alice/posts/post1",
        "users/bob/posts/post2",
      ]);
    });

    it("ID に '/' より小さい文字を含む親でも本家のセグメント順になる", () => {
      // 生のパス文字列比較では "-"（U+002D）< "/"（U+002F）のため
      // "users/user-1/posts/a" が "users/user/posts/b" より先になってしまう。
      // 本家はセグメント単位の比較なので "user" < "user-1"
      docService.setDocument("users/user/posts/b", { likes: 1 });
      docService.setDocument("users/user-1/posts/a", { likes: 2 });

      const results = queryService.executeQuery("posts", [], true);
      expect(results.map((r) => r.path)).toEqual([
        "groups/dev/posts/post3",
        "users/alice/posts/post1",
        "users/bob/posts/post2",
        "users/user/posts/b",
        "users/user-1/posts/a",
      ]);
    });

    it("__name__ カーソル（フルパス）もセグメント順で比較される", () => {
      docService.setDocument("users/user/posts/b", { likes: 1 });
      docService.setDocument("users/user-1/posts/a", { likes: 2 });

      const results = queryService.executeQuery(
        "posts",
        [{ type: "startAfter", values: ["users/user/posts/b"] }],
        true,
      );
      expect(results.map((r) => r.path)).toEqual(["users/user-1/posts/a"]);
    });
  });

  describe("ベクトル近傍検索 (findNearest)", () => {
    beforeEach(() => {
      // {__type:"vector", values:[...]} 形式（クライアント VectorValue のシリアライズ形式）
      docService.setDocument("items/a", {
        name: "A",
        category: "x",
        embedding: { __type: "vector", values: [1, 0, 0] },
      });
      docService.setDocument("items/b", {
        name: "B",
        category: "x",
        embedding: { __type: "vector", values: [0.9, 0.1, 0] },
      });
      docService.setDocument("items/c", {
        name: "C",
        category: "y",
        embedding: { __type: "vector", values: [0, 1, 0] },
      });
      // 素の配列形式も検索対象になる
      docService.setDocument("items/d", {
        name: "D",
        category: "x",
        embedding: [-1, 0, 0],
      });
      // ベクトルなし・次元不一致のドキュメントは対象外
      docService.setDocument("items/e", { name: "E", category: "x" });
      docService.setDocument("items/f", {
        name: "F",
        category: "x",
        embedding: { __type: "vector", values: [1, 0] },
      });
    });

    it("EUCLIDEAN: 距離の近い順に limit 件返す", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 3,
          distanceMeasure: "EUCLIDEAN",
        },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b", "c"]);
    });

    it("COSINE: 角度の近い順に返す", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 2,
          distanceMeasure: "COSINE",
        },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b"]);
    });

    it("DOT_PRODUCT: 内積の大きい順に返す", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 4,
          distanceMeasure: "DOT_PRODUCT",
        },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b", "c", "d"]);
    });

    it("whereフィルタと組み合わせられる", () => {
      const results = queryService.executeQuery("items", [
        { type: "where", fieldPath: "category", op: "==", value: "x" },
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [0, 1, 0],
          limit: 10,
          distanceMeasure: "EUCLIDEAN",
        },
      ]);
      // category=y の c は除外され、ベクトルを持つ a, b, d のみが対象
      expect(results.map((r) => r.documentId).sort()).toEqual(["a", "b", "d"]);
    });

    it("distanceResultField で距離を結果に含められる", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 1,
          distanceMeasure: "EUCLIDEAN",
          distanceResultField: "distance",
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].data.distance).toBe(0);
    });

    it("distanceThreshold で距離の上限を指定できる", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 10,
          distanceMeasure: "EUCLIDEAN",
          distanceThreshold: 0.5,
        },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b"]);
    });

    it("DOT_PRODUCT の distanceThreshold は下限として機能する", () => {
      const results = queryService.executeQuery("items", [
        {
          type: "findNearest",
          fieldPath: "embedding",
          queryVector: [1, 0, 0],
          limit: 10,
          distanceMeasure: "DOT_PRODUCT",
          distanceThreshold: 0.5,
        },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b"]);
    });
  });
});

describe("QueryService - Firestore互換セマンティクス", () => {
  let db: Database.Database;
  let docService: DocumentService;
  let queryService: QueryService;

  const ts = (seconds: number, nanoseconds = 0) => ({
    __type: "timestamp",
    value: { seconds, nanoseconds },
  });

  beforeEach(() => {
    db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    docService = new DocumentService(repo);
    queryService = new QueryService(db);
  });

  describe("Timestamp の比較", () => {
    beforeEach(() => {
      docService.setDocument("events/e1", { name: "e1", at: ts(1700000000) });
      docService.setDocument("events/e2", { name: "e2", at: ts(1700000100) });
      docService.setDocument("events/e3", { name: "e3", at: ts(1700000200) });
    });

    it("Timestamp の範囲フィルタが時系列で機能する", () => {
      const results = queryService.executeQuery("events", [
        { type: "where", fieldPath: "at", op: ">", value: ts(1700000000) },
      ]);
      expect(results.map((r) => r.documentId).sort()).toEqual(["e2", "e3"]);
    });

    it("Timestamp の orderBy が時系列で機能する", () => {
      const results = queryService.executeQuery("events", [
        { type: "orderBy", fieldPath: "at", direction: "desc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["e3", "e2", "e1"]);
    });

    it("Timestamp のカーソルが機能する", () => {
      const results = queryService.executeQuery("events", [
        { type: "orderBy", fieldPath: "at", direction: "asc" },
        { type: "startAfter", values: [ts(1700000000)] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["e2", "e3"]);
    });
  });

  describe("orderBy の欠損フィールド除外", () => {
    it("orderBy 対象フィールドを持たないドキュメントは除外される", () => {
      docService.setDocument("items/a", { rank: 2 });
      docService.setDocument("items/b", {});
      docService.setDocument("items/c", { rank: 1 });
      const results = queryService.executeQuery("items", [
        { type: "orderBy", fieldPath: "rank", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["c", "a"]);
    });

    it("null 値のドキュメントは除外されず先頭に来る", () => {
      docService.setDocument("items/a", { rank: 1 });
      docService.setDocument("items/b", { rank: null });
      const results = queryService.executeQuery("items", [
        { type: "orderBy", fieldPath: "rank", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["b", "a"]);
    });
  });

  describe("型をまたいだ順序・型ブラケット", () => {
    beforeEach(() => {
      docService.setDocument("mixed/bool", { v: true });
      docService.setDocument("mixed/num", { v: 1 });
      docService.setDocument("mixed/str", { v: "1" });
      docService.setDocument("mixed/nul", { v: null });
    });

    it("orderBy は Firestore の型順序 (null < boolean < number < string) に従う", () => {
      const results = queryService.executeQuery("mixed", [
        { type: "orderBy", fieldPath: "v", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["nul", "bool", "num", "str"]);
    });

    it("== は boolean と数値を区別する", () => {
      const results = queryService.executeQuery("mixed", [
        { type: "where", fieldPath: "v", op: "==", value: true },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bool"]);
    });

    it("範囲フィルタは同じ型の値のみマッチする", () => {
      const results = queryService.executeQuery("mixed", [
        { type: "where", fieldPath: "v", op: ">=", value: 0 },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["num"]);
    });

    it("!= はフィールド欠損・null のドキュメントを除外する", () => {
      docService.setDocument("mixed/missing", { other: 1 });
      const results = queryService.executeQuery("mixed", [
        { type: "where", fieldPath: "v", op: "!=", value: 1 },
      ]);
      expect(results.map((r) => r.documentId).sort()).toEqual(["bool", "str"]);
    });
  });

  describe("暗黙の __name__ 順序", () => {
    it("orderBy なしのクエリはドキュメントパス昇順で返る", () => {
      docService.setDocument("items/c", { v: 1 });
      docService.setDocument("items/a", { v: 2 });
      docService.setDocument("items/b", { v: 3 });
      const results = queryService.executeQuery("items", []);
      expect(results.map((r) => r.documentId)).toEqual(["a", "b", "c"]);
    });

    it("orderBy の同値は __name__ でタイブレークされる", () => {
      docService.setDocument("items/c", { v: 1 });
      docService.setDocument("items/a", { v: 1 });
      docService.setDocument("items/b", { v: 0 });
      const results = queryService.executeQuery("items", [
        { type: "orderBy", fieldPath: "v", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["b", "a", "c"]);
    });

    it("不等式フィルタのみのクエリはそのフィールドで暗黙にソートされる", () => {
      docService.setDocument("items/a", { v: 3 });
      docService.setDocument("items/b", { v: 1 });
      docService.setDocument("items/c", { v: 2 });
      const results = queryService.executeQuery("items", [
        { type: "where", fieldPath: "v", op: ">", value: 0 },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["b", "c", "a"]);
    });
  });

  describe("複数 orderBy のカーソル", () => {
    beforeEach(() => {
      docService.setDocument("posts/p1", { category: "a", score: 1 });
      docService.setDocument("posts/p2", { category: "a", score: 2 });
      docService.setDocument("posts/p3", { category: "b", score: 1 });
      docService.setDocument("posts/p4", { category: "b", score: 2 });
    });

    it("startAfter がタプル比較（辞書式）で機能する", () => {
      const results = queryService.executeQuery("posts", [
        { type: "orderBy", fieldPath: "category", direction: "asc" },
        { type: "orderBy", fieldPath: "score", direction: "asc" },
        { type: "startAfter", values: ["a", 1] },
      ]);
      // 単純 AND なら p3 (b,1) が漏れるが、辞書式なら含まれる
      expect(results.map((r) => r.documentId)).toEqual(["p2", "p3", "p4"]);
    });

    it("asc + desc 混在の startAt が機能する", () => {
      const results = queryService.executeQuery("posts", [
        { type: "orderBy", fieldPath: "category", direction: "asc" },
        { type: "orderBy", fieldPath: "score", direction: "desc" },
        { type: "startAt", values: ["a", 1] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["p1", "p4", "p3"]);
    });
  });

  describe("limit / limitToLast", () => {
    it("limitToLast は orderBy なしでエラーになる", () => {
      docService.setDocument("items/a", { v: 1 });
      expect(() => queryService.executeQuery("items", [{ type: "limitToLast", limit: 2 }])).toThrow(
        QueryValidationError,
      );
    });

    it("limit と limitToLast が両方指定された場合は最後が有効", () => {
      docService.setDocument("items/a", { v: 1 });
      docService.setDocument("items/b", { v: 2 });
      docService.setDocument("items/c", { v: 3 });
      const results = queryService.executeQuery("items", [
        { type: "orderBy", fieldPath: "v", direction: "asc" },
        { type: "limit", limit: 1 },
        { type: "limitToLast", limit: 2 },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["b", "c"]);
    });
  });

  describe("array-contains の等値セマンティクス", () => {
    it("boolean 要素は数値要素とマッチしない", () => {
      docService.setDocument("items/a", { tags: [1, 2] });
      docService.setDocument("items/b", { tags: [true] });
      const results = queryService.executeQuery("items", [
        { type: "where", fieldPath: "tags", op: "array-contains", value: true },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["b"]);
    });

    it("Timestamp 要素がマッチする", () => {
      docService.setDocument("items/a", { times: [ts(100), ts(200)] });
      docService.setDocument("items/b", { times: [ts(300)] });
      const results = queryService.executeQuery("items", [
        { type: "where", fieldPath: "times", op: "array-contains", value: ts(200) },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["a"]);
    });
  });

  describe("クエリフィルタの防御的バリデーション（B-2）", () => {
    it("in の31要素以上は QueryValidationError になる", () => {
      const values = Array.from({ length: 31 }, (_, i) => i);
      expect(() =>
        queryService.executeQuery("users", [
          { type: "where", fieldPath: "age", op: "in", value: values },
        ]),
      ).toThrow(QueryValidationError);
    });

    it("not-in の11要素以上は QueryValidationError になる", () => {
      const values = Array.from({ length: 11 }, (_, i) => i);
      expect(() =>
        queryService.executeQuery("users", [
          { type: "where", fieldPath: "age", op: "not-in", value: values },
        ]),
      ).toThrow(QueryValidationError);
    });

    it("array-contains の複数指定は QueryValidationError になる", () => {
      expect(() =>
        queryService.executeQuery("users", [
          { type: "where", fieldPath: "tags", op: "array-contains", value: "a" },
          { type: "where", fieldPath: "tags", op: "array-contains", value: "b" },
        ]),
      ).toThrow(QueryValidationError);
    });

    it("not-in と != の併用は QueryValidationError になる", () => {
      expect(() =>
        queryService.executeQuery("users", [
          { type: "where", fieldPath: "age", op: "not-in", value: [1] },
          { type: "where", fieldPath: "name", op: "!=", value: "x" },
        ]),
      ).toThrow(QueryValidationError);
    });

    it("executeAggregate でも同じ検証が行われる", () => {
      const values = Array.from({ length: 31 }, (_, i) => i);
      expect(() =>
        queryService.executeAggregate(
          "users",
          [{ type: "where", fieldPath: "age", op: "in", value: values }],
          { total: { aggregateType: "count" } },
        ),
      ).toThrow(QueryValidationError);
    });
  });

  describe("データ忠実度（Phase 3）", () => {
    it("sum / avg は数値フィールドのみを集計する（文字列混在）", () => {
      docService.setDocument("scores/a", { v: 10 });
      docService.setDocument("scores/b", { v: 20 });
      docService.setDocument("scores/c", { v: "not-a-number" });
      docService.setDocument("scores/d", { v: true });
      docService.setDocument("scores/e", { other: 1 }); // フィールド欠損

      const result = queryService.executeAggregate("scores", [], {
        total: { aggregateType: "sum", fieldPath: "v" },
        average: { aggregateType: "avg", fieldPath: "v" },
        count: { aggregateType: "count" },
      });
      expect(result.total).toBe(30);
      // 平均の分母にも数値のみが入る（(10+20)/2 = 15。文字列を 0 扱いしない）
      expect(result.average).toBe(15);
      expect(result.count).toBe(5);
    });

    it("集計は limit 適用後の結果集合に対して行われる", () => {
      for (let i = 1; i <= 5; i++) {
        docService.setDocument(`scores/s${i}`, { v: i * 10 });
      }

      const result = queryService.executeAggregate(
        "scores",
        [
          { type: "orderBy", fieldPath: "v", direction: "asc" },
          { type: "limit", limit: 3 },
        ],
        {
          count: { aggregateType: "count" },
          total: { aggregateType: "sum", fieldPath: "v" },
          average: { aggregateType: "avg", fieldPath: "v" },
        },
      );
      // 10, 20, 30 の 3 件のみが対象
      expect(result.count).toBe(3);
      expect(result.total).toBe(60);
      expect(result.average).toBe(20);
    });

    it("集計はカーソル（startAfter）適用後の結果集合に対して行われる", () => {
      for (let i = 1; i <= 5; i++) {
        docService.setDocument(`scores/s${i}`, { v: i * 10 });
      }

      const result = queryService.executeAggregate(
        "scores",
        [
          { type: "orderBy", fieldPath: "v", direction: "asc" },
          { type: "startAfter", values: [20] },
        ],
        { count: { aggregateType: "count" } },
      );
      // 30, 40, 50 の 3 件
      expect(result.count).toBe(3);
    });

    it("集計は limitToLast 適用後の結果集合に対して行われる", () => {
      for (let i = 1; i <= 5; i++) {
        docService.setDocument(`scores/s${i}`, { v: i * 10 });
      }

      const result = queryService.executeAggregate(
        "scores",
        [
          { type: "orderBy", fieldPath: "v", direction: "asc" },
          { type: "limitToLast", limit: 2 },
        ],
        {
          count: { aggregateType: "count" },
          total: { aggregateType: "sum", fieldPath: "v" },
        },
      );
      // 末尾の 40, 50 の 2 件
      expect(result.count).toBe(2);
      expect(result.total).toBe(90);
    });

    it("集計は orderBy 対象フィールド欠損ドキュメントを除外する（本家と同じ）", () => {
      docService.setDocument("scores/a", { v: 10 });
      docService.setDocument("scores/b", { other: 1 }); // v 欠損

      const result = queryService.executeAggregate(
        "scores",
        [{ type: "orderBy", fieldPath: "v", direction: "asc" }],
        { count: { aggregateType: "count" } },
      );
      expect(result.count).toBe(1);
    });

    it("数値が1つもない場合 sum は 0、avg は null", () => {
      docService.setDocument("scores/a", { v: "text" });
      const result = queryService.executeAggregate("scores", [], {
        total: { aggregateType: "sum", fieldPath: "v" },
        average: { aggregateType: "avg", fieldPath: "v" },
      });
      expect(result.total).toBe(0);
      expect(result.average).toBeNull();
    });

    it("NaN は数値の最小としてソートされる", () => {
      docService.setDocument("nums/nan", { v: { __type: "double", value: "NaN" } });
      docService.setDocument("nums/neginf", { v: { __type: "double", value: "-Infinity" } });
      docService.setDocument("nums/zero", { v: 0 });
      docService.setDocument("nums/one", { v: 1 });

      const results = queryService.executeQuery("nums", [
        { type: "orderBy", fieldPath: "v", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["nan", "neginf", "zero", "one"]);
    });

    it("== NaN フィルタがマッチする（本家仕様）", () => {
      docService.setDocument("nums/nan", { v: { __type: "double", value: "NaN" } });
      docService.setDocument("nums/one", { v: 1 });

      const results = queryService.executeQuery("nums", [
        { type: "where", fieldPath: "v", op: "==", value: { __type: "double", value: "NaN" } },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["nan"]);
    });

    it("Infinity の range フィルタと等値が機能する", () => {
      docService.setDocument("nums/inf", { v: { __type: "double", value: "Infinity" } });
      docService.setDocument("nums/big", { v: 1e308 });

      const eq = queryService.executeQuery("nums", [
        { type: "where", fieldPath: "v", op: "==", value: { __type: "double", value: "Infinity" } },
      ]);
      expect(eq.map((r) => r.documentId)).toEqual(["inf"]);

      const gt = queryService.executeQuery("nums", [
        { type: "where", fieldPath: "v", op: ">", value: 1e307 },
      ]);
      expect(gt.map((r) => r.documentId).sort()).toEqual(["big", "inf"]);
    });
  });
});
