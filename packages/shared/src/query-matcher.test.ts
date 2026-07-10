import { describe, expect, it } from "vitest";
import { applyQueryConstraints, matchesQueryFilters } from "./query-matcher.js";
import type { SerializedQueryConstraint } from "./types.js";

function doc(path: string, data: Record<string, unknown>) {
  return { path, data };
}

function ts(seconds: number, nanoseconds = 0) {
  return { __type: "timestamp", value: { seconds, nanoseconds } };
}

const users = [
  doc("users/alice", { name: "Alice", age: 30, status: "active", tags: ["ts", "node"] }),
  doc("users/bob", { name: "Bob", age: 25, status: "inactive", tags: ["python"] }),
  doc("users/carol", { name: "Carol", age: 35, status: "active", tags: ["ts", "go"] }),
  doc("users/dave", { name: "Dave", status: "active" }), // age 欠損
];

function run(
  constraints: SerializedQueryConstraint[],
  docs = users,
  path = "users",
  group = false,
) {
  return applyQueryConstraints(docs, path, group, constraints).map((d) => d.path);
}

describe("matchesQueryFilters", () => {
  it("コレクションパスが一致しないドキュメントはマッチしない", () => {
    expect(matchesQueryFilters(doc("posts/p1", {}), "users", false, [])).toBe(false);
    expect(matchesQueryFilters(doc("users/alice", {}), "users", false, [])).toBe(true);
    // サブコレクションは親コレクションのクエリにマッチしない
    expect(matchesQueryFilters(doc("users/alice/posts/p1", {}), "users", false, [])).toBe(false);
  });

  it("コレクショングループは末尾コレクション名でマッチする", () => {
    expect(matchesQueryFilters(doc("users/a/posts/p1", {}), "posts", true, [])).toBe(true);
    expect(matchesQueryFilters(doc("posts/p1", {}), "posts", true, [])).toBe(true);
    expect(matchesQueryFilters(doc("users/a/comments/c1", {}), "posts", true, [])).toBe(false);
  });

  it("== フィルタは欠損フィールドにマッチしない", () => {
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "age", op: "==", value: 30 },
    ];
    expect(matchesQueryFilters(users[0], "users", false, constraints)).toBe(true);
    expect(matchesQueryFilters(users[3], "users", false, constraints)).toBe(false);
  });

  it("!= は欠損 / null のドキュメントにマッチしない", () => {
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "age", op: "!=", value: 30 },
    ];
    expect(matchesQueryFilters(users[1], "users", false, constraints)).toBe(true);
    expect(matchesQueryFilters(users[0], "users", false, constraints)).toBe(false);
    expect(matchesQueryFilters(users[3], "users", false, constraints)).toBe(false); // 欠損
    expect(matchesQueryFilters(doc("users/x", { age: null }), "users", false, constraints)).toBe(
      false,
    ); // null
  });

  it("範囲フィルタは型ブラケットで同型のみマッチする", () => {
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "v", op: ">", value: 10 },
    ];
    expect(matchesQueryFilters(doc("c/n", { v: 20 }), "c", false, constraints)).toBe(true);
    // 文字列は数値より型順序が大きいがマッチしない（型ブラケット）
    expect(matchesQueryFilters(doc("c/s", { v: "text" }), "c", false, constraints)).toBe(false);
  });

  it("array-contains / in / not-in が Firestore 等値で判定される", () => {
    expect(
      matchesQueryFilters(users[0], "users", false, [
        { type: "where", fieldPath: "tags", op: "array-contains", value: "ts" },
      ]),
    ).toBe(true);
    expect(
      matchesQueryFilters(users[1], "users", false, [
        { type: "where", fieldPath: "age", op: "in", value: [25, 99] },
      ]),
    ).toBe(true);
    expect(
      matchesQueryFilters(users[3], "users", false, [
        { type: "where", fieldPath: "age", op: "not-in", value: [30] },
      ]),
    ).toBe(false); // 欠損は not-in にマッチしない
  });

  it("Timestamp ラッパーの比較が機能する", () => {
    const docs = [doc("e/a", { at: ts(100) }), doc("e/b", { at: ts(200) })];
    expect(
      matchesQueryFilters(docs[0], "e", false, [
        { type: "where", fieldPath: "at", op: "<", value: ts(150) },
      ]),
    ).toBe(true);
    expect(
      matchesQueryFilters(docs[1], "e", false, [
        { type: "where", fieldPath: "at", op: "<", value: ts(150) },
      ]),
    ).toBe(false);
  });

  it("__name__ フィルタはドキュメントIDで比較する", () => {
    expect(
      matchesQueryFilters(users[0], "users", false, [
        { type: "where", fieldPath: "__name__", op: "==", value: "alice" },
      ]),
    ).toBe(true);
    expect(
      matchesQueryFilters(users[0], "users", false, [
        { type: "where", fieldPath: "__name__", op: "in", value: ["bob", "carol"] },
      ]),
    ).toBe(false);
  });

  it("and / or 複合フィルタを評価する", () => {
    const orFilter: SerializedQueryConstraint = {
      type: "or",
      filters: [
        { type: "where", fieldPath: "age", op: "==", value: 25 },
        { type: "where", fieldPath: "age", op: "==", value: 35 },
      ],
    };
    expect(matchesQueryFilters(users[1], "users", false, [orFilter])).toBe(true);
    expect(matchesQueryFilters(users[0], "users", false, [orFilter])).toBe(false);
  });

  it("ネストしたフィールドパス（ドット記法）を解決する", () => {
    const d = doc("c/x", { profile: { address: { city: "Tokyo" } } });
    expect(
      matchesQueryFilters(d, "c", false, [
        { type: "where", fieldPath: "profile.address.city", op: "==", value: "Tokyo" },
      ]),
    ).toBe(true);
  });
});

describe("applyQueryConstraints", () => {
  it("フィルタなしでは __name__ 順に返す", () => {
    expect(run([])).toEqual(["users/alice", "users/bob", "users/carol", "users/dave"]);
  });

  it("orderBy でソートし、欠損フィールドのドキュメントを除外する", () => {
    expect(run([{ type: "orderBy", fieldPath: "age", direction: "asc" }])).toEqual([
      "users/bob",
      "users/alice",
      "users/carol",
    ]);
    expect(run([{ type: "orderBy", fieldPath: "age", direction: "desc" }])).toEqual([
      "users/carol",
      "users/alice",
      "users/bob",
    ]);
  });

  it("同値は __name__ でタイブレークされる（方向は最後の orderBy に従う）", () => {
    expect(run([{ type: "orderBy", fieldPath: "status", direction: "asc" }])).toEqual([
      "users/alice",
      "users/carol",
      "users/dave",
      "users/bob",
    ]);
    expect(run([{ type: "orderBy", fieldPath: "status", direction: "desc" }])).toEqual([
      "users/bob",
      "users/dave",
      "users/carol",
      "users/alice",
    ]);
  });

  it("不等式フィルタは暗黙にそのフィールドでソートする", () => {
    expect(run([{ type: "where", fieldPath: "age", op: ">", value: 20 }])).toEqual([
      "users/bob",
      "users/alice",
      "users/carol",
    ]);
  });

  it("limit / limitToLast（最後の指定が有効）", () => {
    const orderByAge: SerializedQueryConstraint = {
      type: "orderBy",
      fieldPath: "age",
      direction: "asc",
    };
    expect(run([orderByAge, { type: "limit", limit: 2 }])).toEqual(["users/bob", "users/alice"]);
    expect(run([orderByAge, { type: "limitToLast", limit: 2 }])).toEqual([
      "users/alice",
      "users/carol",
    ]);
    expect(run([orderByAge, { type: "limit", limit: 3 }, { type: "limit", limit: 1 }])).toEqual([
      "users/bob",
    ]);
  });

  it("limitToLast は orderBy なしでエラーになる", () => {
    expect(() => run([{ type: "limitToLast", limit: 1 }])).toThrow(/orderBy/);
  });

  it("カーソル（startAfter / endAt）が辞書式タプル比較で機能する", () => {
    const orderByAge: SerializedQueryConstraint = {
      type: "orderBy",
      fieldPath: "age",
      direction: "asc",
    };
    expect(run([orderByAge, { type: "startAfter", values: [25] }])).toEqual([
      "users/alice",
      "users/carol",
    ]);
    expect(run([orderByAge, { type: "startAt", values: [30] }])).toEqual([
      "users/alice",
      "users/carol",
    ]);
    expect(run([orderByAge, { type: "endBefore", values: [35] }])).toEqual([
      "users/bob",
      "users/alice",
    ]);
    expect(run([orderByAge, { type: "endAt", values: [30] }])).toEqual([
      "users/bob",
      "users/alice",
    ]);
  });

  it("__name__ カーソル値は相対IDをフルパスへ正規化する", () => {
    expect(run([{ type: "startAfter", values: ["bob"] }])).toEqual(["users/carol", "users/dave"]);
  });

  it("コレクショングループクエリを評価する", () => {
    const docs = [
      doc("posts/p1/comments/c1", { v: 1 }),
      doc("articles/a1/comments/c2", { v: 2 }),
      doc("posts/p1/replies/r1", { v: 3 }),
    ];
    expect(run([], docs, "comments", true)).toEqual([
      "articles/a1/comments/c2",
      "posts/p1/comments/c1",
    ]);
  });

  it("findNearest はローカル評価できない", () => {
    expect(() =>
      run([
        {
          type: "findNearest",
          fieldPath: "v",
          queryVector: [1],
          limit: 1,
          distanceMeasure: "EUCLIDEAN",
        },
      ]),
    ).toThrow(/findNearest/);
  });
});
