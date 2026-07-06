import { describe, expect, it } from "vitest";
import { getFirestore } from "./firestore.js";
import type {
  QueryConstraintType,
  QueryFilterConstraint,
  QueryNonFilterConstraint,
} from "./query.js";
import {
  and,
  collectionGroup,
  endAt,
  endBefore,
  findNearest,
  limit,
  limitToLast,
  or,
  orderBy,
  query,
  startAfter,
  startAt,
  validateConstraints,
  where,
} from "./query.js";
import { collection, doc } from "./references.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
import { DocumentSnapshot, FieldPath, Timestamp } from "./types.js";
import { vector } from "./vector.js";

describe("query()", () => {
  const db = getFirestore();
  const usersRef = collection(db, "users");

  it("CollectionReferenceからQueryを作成できる", () => {
    const q = query(usersRef);
    expect(q.type).toBe("query");
    expect(q.collectionPath).toBe("users");
    expect(q.collectionGroup).toBe(false);
    expect(q.constraints).toEqual([]);
  });

  it("制約を付与してQueryを作成できる", () => {
    const q = query(usersRef, where("age", ">=", 18), orderBy("age", "asc"), limit(10));
    expect(q.constraints).toHaveLength(3);
    expect(q.constraints[0]).toEqual({ type: "where", fieldPath: "age", op: ">=", value: 18 });
    expect(q.constraints[1]).toEqual({ type: "orderBy", fieldPath: "age", direction: "asc" });
    expect(q.constraints[2]).toEqual({ type: "limit", limit: 10 });
  });

  it("Queryに追加の制約を加えられる", () => {
    const q1 = query(usersRef, where("status", "==", "active"));
    const q2 = query(q1, orderBy("age"));
    expect(q2.constraints).toHaveLength(2);
    expect(q2.constraints[0]).toEqual({
      type: "where",
      fieldPath: "status",
      op: "==",
      value: "active",
    });
    expect(q2.constraints[1]).toEqual({ type: "orderBy", fieldPath: "age", direction: "asc" });
  });
});

describe("collectionGroup()", () => {
  const db = getFirestore();

  it("コレクショングループクエリを作成できる", () => {
    const q = collectionGroup(db, "posts");
    expect(q.type).toBe("query");
    expect(q.collectionPath).toBe("posts");
    expect(q.collectionGroup).toBe(true);
  });
});

describe("制約ヘルパー", () => {
  it("where", () => {
    const c = where("name", "==", "Alice");
    expect(c._serialized).toEqual({ type: "where", fieldPath: "name", op: "==", value: "Alice" });
  });

  it("orderBy (デフォルトasc)", () => {
    const c = orderBy("age");
    expect(c._serialized).toEqual({ type: "orderBy", fieldPath: "age", direction: "asc" });
  });

  it("orderBy (desc)", () => {
    const c = orderBy("age", "desc");
    expect(c._serialized).toEqual({ type: "orderBy", fieldPath: "age", direction: "desc" });
  });

  it("limit", () => {
    expect(limit(5)._serialized).toEqual({ type: "limit", limit: 5 });
  });

  it("limitToLast", () => {
    expect(limitToLast(3)._serialized).toEqual({ type: "limitToLast", limit: 3 });
  });

  it("startAt", () => {
    expect(startAt(10)._serialized).toEqual({ type: "startAt", values: [10] });
  });

  it("startAfter", () => {
    expect(startAfter(10)._serialized).toEqual({ type: "startAfter", values: [10] });
  });

  it("endAt", () => {
    expect(endAt(20)._serialized).toEqual({ type: "endAt", values: [20] });
  });

  it("endBefore", () => {
    expect(endBefore(20)._serialized).toEqual({ type: "endBefore", values: [20] });
  });

  it("and()", () => {
    const c = and(where("a", "==", 1), where("b", ">", 2));
    expect(c._serialized).toEqual({
      type: "and",
      filters: [
        { type: "where", fieldPath: "a", op: "==", value: 1 },
        { type: "where", fieldPath: "b", op: ">", value: 2 },
      ],
    });
  });

  it("or()", () => {
    const c = or(where("x", "==", 1), where("x", "==", 2));
    expect(c._serialized).toEqual({
      type: "or",
      filters: [
        { type: "where", fieldPath: "x", op: "==", value: 1 },
        { type: "where", fieldPath: "x", op: "==", value: 2 },
      ],
    });
  });
});

describe("findNearest()", () => {
  const db = getFirestore();
  const itemsRef = collection(db, "items");

  it("findNearest制約付きのQueryを作成できる", () => {
    const q = findNearest(itemsRef, {
      vectorField: "embedding",
      queryVector: [1, 2, 3],
      limit: 5,
      distanceMeasure: "COSINE",
    });
    expect(q.type).toBe("query");
    expect(q.constraints).toEqual([
      {
        type: "findNearest",
        fieldPath: "embedding",
        queryVector: [1, 2, 3],
        limit: 5,
        distanceMeasure: "COSINE",
        distanceResultField: undefined,
        distanceThreshold: undefined,
      },
    ]);
  });

  it("VectorValueをクエリベクトルとして渡せる", () => {
    const q = findNearest(itemsRef, {
      vectorField: "embedding",
      queryVector: vector([0.5, 0.5]),
      limit: 3,
      distanceMeasure: "EUCLIDEAN",
    });
    const c = q.constraints[0] as { queryVector: number[] };
    expect(c.queryVector).toEqual([0.5, 0.5]);
  });

  it("FieldPathをvectorFieldとして渡せる", () => {
    const q = findNearest(itemsRef, {
      vectorField: new FieldPath("nested", "embedding"),
      queryVector: [1, 0],
      limit: 1,
      distanceMeasure: "DOT_PRODUCT",
    });
    const c = q.constraints[0] as { fieldPath: string };
    expect(c.fieldPath).toBe("nested.embedding");
  });

  it("whereフィルタ済みQueryと組み合わせられる", () => {
    const base = query(itemsRef, where("category", "==", "x"));
    const q = findNearest(base, {
      vectorField: "embedding",
      queryVector: [1],
      limit: 2,
      distanceMeasure: "EUCLIDEAN",
      distanceResultField: "distance",
      distanceThreshold: 0.5,
    });
    expect(q.constraints).toHaveLength(2);
    expect(q.constraints[1]).toMatchObject({
      type: "findNearest",
      distanceResultField: "distance",
      distanceThreshold: 0.5,
    });
  });

  it("空のqueryVectorはエラー", () => {
    expect(() =>
      findNearest(itemsRef, {
        vectorField: "embedding",
        queryVector: [],
        limit: 1,
        distanceMeasure: "COSINE",
      }),
    ).toThrow(FirestoreError);
  });

  it("非有限数を含むqueryVectorはエラー", () => {
    expect(() =>
      findNearest(itemsRef, {
        vectorField: "embedding",
        queryVector: [1, Number.NaN],
        limit: 1,
        distanceMeasure: "COSINE",
      }),
    ).toThrow(FirestoreError);
  });

  it("limitが正の整数でない場合はエラー", () => {
    expect(() =>
      findNearest(itemsRef, {
        vectorField: "embedding",
        queryVector: [1],
        limit: 0,
        distanceMeasure: "COSINE",
      }),
    ).toThrow(FirestoreError);
  });
});

describe("クエリ制約の型定義 (2-5)", () => {
  const db = getFirestore();
  const usersRef = collection(db, "users");

  it("QueryConstraintType は firebase 互換の制約種別リテラルを網羅する", () => {
    const types: QueryConstraintType[] = [
      "where",
      "orderBy",
      "limit",
      "limitToLast",
      "startAt",
      "startAfter",
      "endAt",
      "endBefore",
    ];
    expect(types).toHaveLength(8);

    // @ts-expect-error 未定義の制約種別は型エラー
    const invalid: QueryConstraintType = "unknownConstraint";
    expect(invalid).toBeDefined();
  });

  it("QueryFilterConstraint / QueryNonFilterConstraint を query() に渡せる", () => {
    const filter: QueryFilterConstraint = where("age", ">=", 18);
    const composite: QueryFilterConstraint = or(
      where("status", "==", "active"),
      where("status", "==", "pending"),
    );
    const nonFilter: QueryNonFilterConstraint = orderBy("age");
    const limitConstraint: QueryNonFilterConstraint = limit(10);

    const q = query(usersRef, filter, composite, nonFilter, limitConstraint);
    expect(q.constraints).toHaveLength(4);
    expect(q.constraints.map((c) => c.type)).toEqual(["where", "or", "orderBy", "limit"]);
  });
});

describe("スナップショットカーソル (startAt(snapshot) 形式)", () => {
  const db = getFirestore();
  const usersRef = collection(db, "users");
  const iso = "2026-01-01T00:00:00.000Z";
  const snap = new QueryDocumentSnapshot(
    "users/alice",
    "alice",
    { age: 30, name: "Alice" },
    iso,
    iso,
    db,
  );

  it("startAfter(snapshot) は orderBy フィールドの値 + __name__ へ展開される", () => {
    const q = query(usersRef, orderBy("age"), startAfter(snap));
    expect(q.constraints[1]).toEqual({
      type: "startAfter",
      values: [30, "users/alice"],
    });
  });

  it("複数 orderBy のフィールド値が順番に展開される", () => {
    const q = query(usersRef, orderBy("age"), orderBy("name", "desc"), startAt(snap));
    expect(q.constraints[2]).toEqual({
      type: "startAt",
      values: [30, "Alice", "users/alice"],
    });
  });

  it("orderBy なしの場合は __name__（ドキュメントパス）のみ", () => {
    const q = query(usersRef, startAfter(snap));
    expect(q.constraints[0]).toEqual({
      type: "startAfter",
      values: ["users/alice"],
    });
  });

  it("orderBy('__name__') 明示時はパス値を重複させない", () => {
    const q = query(usersRef, orderBy("__name__"), endAt(snap));
    expect(q.constraints[1]).toEqual({
      type: "endAt",
      values: ["users/alice"],
    });
  });

  it("endBefore(snapshot) も展開される", () => {
    const q = query(usersRef, orderBy("age"), endBefore(snap));
    expect(q.constraints[1]).toEqual({
      type: "endBefore",
      values: [30, "users/alice"],
    });
  });

  it("ベースクエリの orderBy も使って展開される", () => {
    const base = query(usersRef, orderBy("age"));
    const q = query(base, startAfter(snap));
    expect(q.constraints[1]).toEqual({
      type: "startAfter",
      values: [30, "users/alice"],
    });
  });

  it("getDoc 結果の DocumentSnapshot も渡せる", () => {
    const ref = doc(usersRef, "bob");
    const docSnap = new DocumentSnapshot(ref, { age: 25 }, iso, iso);
    const q = query(usersRef, orderBy("age"), startAfter(docSnap));
    expect(q.constraints[1]).toEqual({
      type: "startAfter",
      values: [25, "users/bob"],
    });
  });

  it("orderBy フィールドがスナップショットに存在しない場合はエラー", () => {
    expect(() => query(usersRef, orderBy("missing"), startAfter(snap))).toThrowError(
      FirestoreError,
    );
  });

  it("存在しないドキュメントのスナップショットはエラー", () => {
    const ref = doc(usersRef, "ghost");
    const missing = new DocumentSnapshot(ref, null, null, null);
    expect(() => startAfter(missing)).toThrowError(FirestoreError);
  });

  it("Timestamp などの特殊型はシリアライズされて展開される", () => {
    const ts = new Timestamp(1700000000, 0);
    const tsSnap = new QueryDocumentSnapshot(
      "users/carol",
      "carol",
      { createdAt: ts },
      iso,
      iso,
      db,
    );
    const q = query(usersRef, orderBy("createdAt"), startAfter(tsSnap));
    expect(q.constraints[1]).toEqual({
      type: "startAfter",
      values: [
        { __type: "timestamp", value: { seconds: 1700000000, nanoseconds: 0 } },
        "users/carol",
      ],
    });
  });

  it("フィールド値の列挙による従来形式も引き続き動作する", () => {
    const q = query(usersRef, orderBy("age"), startAfter(30));
    expect(q.constraints[1]).toEqual({ type: "startAfter", values: [30] });
  });
});

describe("validateConstraints（本家パリティのクエリバリデーション）", () => {
  const db = getFirestore();
  const usersRef = collection(db, "users");

  function expectInvalid(constraints: Parameters<typeof validateConstraints>[0], match: string) {
    try {
      validateConstraints(constraints);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("invalid-argument");
      expect((e as FirestoreError).message).toContain(match);
    }
  }

  it("in / array-contains-any の31要素以上はエラーになる", () => {
    const values = Array.from({ length: 31 }, (_, i) => i);
    const q = query(usersRef, where("age", "in", values));
    expectInvalid(q.constraints, "maximum of 30");
    const q2 = query(usersRef, where("tags", "array-contains-any", values));
    expectInvalid(q2.constraints, "maximum of 30");
  });

  it("not-in の11要素以上はエラーになる", () => {
    const values = Array.from({ length: 11 }, (_, i) => i);
    const q = query(usersRef, where("age", "not-in", values));
    expectInvalid(q.constraints, "maximum of 10");
  });

  it("in の空配列はエラーになる", () => {
    const q = query(usersRef, where("age", "in", []));
    expectInvalid(q.constraints, "non-empty array");
  });

  it("array-contains の複数指定はエラーになる", () => {
    const q = query(usersRef, where("a", "array-contains", 1), where("b", "array-contains", 2));
    expectInvalid(q.constraints, "more than one 'array-contains'");
  });

  it("not-in と != の併用はエラーになる", () => {
    const q = query(usersRef, where("a", "not-in", [1]), where("b", "!=", 2));
    expectInvalid(q.constraints, "'not-in' filters with '!='");
  });

  it("not-in と in の併用はエラーになる", () => {
    const q = query(usersRef, where("a", "not-in", [1]), where("b", "in", [2]));
    expectInvalid(q.constraints, "'not-in' filters with 'in'");
  });

  it("有効なクエリはエラーにならない", () => {
    const q = query(
      usersRef,
      where("age", "in", [1, 2, 3]),
      where("tags", "array-contains", "a"),
      limit(10),
    );
    expect(() => validateConstraints(q.constraints)).not.toThrow();
  });
});
