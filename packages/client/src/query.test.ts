import { describe, it, expect } from "vitest";
import { getFirestore } from "./firestore.js";
import { collection } from "./references.js";
import {
  query,
  collectionGroup,
  where,
  orderBy,
  limit,
  limitToLast,
  startAt,
  startAfter,
  endAt,
  endBefore,
  and,
  or,
} from "./query.js";

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
    const q = query(
      usersRef,
      where("age", ">=", 18),
      orderBy("age", "asc"),
      limit(10),
    );
    expect(q.constraints).toHaveLength(3);
    expect(q.constraints[0]).toEqual({ type: "where", fieldPath: "age", op: ">=", value: 18 });
    expect(q.constraints[1]).toEqual({ type: "orderBy", fieldPath: "age", direction: "asc" });
    expect(q.constraints[2]).toEqual({ type: "limit", limit: 10 });
  });

  it("Queryに追加の制約を加えられる", () => {
    const q1 = query(usersRef, where("status", "==", "active"));
    const q2 = query(q1, orderBy("age"));
    expect(q2.constraints).toHaveLength(2);
    expect(q2.constraints[0]).toEqual({ type: "where", fieldPath: "status", op: "==", value: "active" });
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
