import { describe, expect, it } from "vitest";
import {
  AggregateField,
  AggregateQuerySnapshot,
  aggregateFieldEqual,
  aggregateQuerySnapshotEqual,
  average,
  count,
  sum,
} from "./aggregate.js";
import type { Query } from "./query.js";

describe("count()", () => {
  it("AggregateFieldを返す", () => {
    const field = count();
    expect(field).toBeInstanceOf(AggregateField);
    expect(field.type).toBe("AggregateField");
    expect(field.aggregateType).toBe("count");
    expect(field.fieldPath).toBeUndefined();
  });
});

describe("sum()", () => {
  it("fieldPath付きのAggregateFieldを返す", () => {
    const field = sum("age");
    expect(field).toBeInstanceOf(AggregateField);
    expect(field.aggregateType).toBe("sum");
    expect(field.fieldPath).toBe("age");
  });
});

describe("average()", () => {
  it("fieldPath付きのAggregateFieldを返す", () => {
    const field = average("score");
    expect(field).toBeInstanceOf(AggregateField);
    expect(field.aggregateType).toBe("avg");
    expect(field.fieldPath).toBe("score");
  });
});

describe("AggregateQuerySnapshot", () => {
  it("data()で集計結果を取得できる", () => {
    const mockQuery = {
      type: "query" as const,
      collectionPath: "users",
      collectionGroup: false,
      constraints: [],
      _firestore: { type: "firestore" as const, _transport: {} as never },
      _converter: null,
      withConverter: (() => mockQuery) as never,
    };

    const snapshot = new AggregateQuerySnapshot(mockQuery, {
      count: 10,
      totalAge: 300,
      avgAge: 30,
    });

    expect(snapshot.type).toBe("AggregateQuerySnapshot");
    expect(snapshot.query).toBe(mockQuery);

    const data = snapshot.data();
    expect(data.count).toBe(10);
    expect(data.totalAge).toBe(300);
    expect(data.avgAge).toBe(30);
  });
});

function makeQuery(collectionPath: string): Query {
  const mockQuery = {
    type: "query" as const,
    collectionPath,
    collectionGroup: false,
    constraints: [],
    _firestore: { type: "firestore" as const, _transport: {} as never },
    _converter: null,
    withConverter: (() => mockQuery) as never,
  };
  return mockQuery as unknown as Query;
}

describe("aggregateFieldEqual()", () => {
  it("同じ集計タイプ・フィールドなら true", () => {
    expect(aggregateFieldEqual(count(), count())).toBe(true);
    expect(aggregateFieldEqual(sum("age"), sum("age"))).toBe(true);
    expect(aggregateFieldEqual(average("score"), average("score"))).toBe(true);
  });

  it("集計タイプが異なると false", () => {
    expect(aggregateFieldEqual(sum("age"), average("age"))).toBe(false);
    expect(aggregateFieldEqual(count(), sum("age"))).toBe(false);
  });

  it("フィールドパスが異なると false", () => {
    expect(aggregateFieldEqual(sum("age"), sum("score"))).toBe(false);
  });
});

describe("aggregateQuerySnapshotEqual()", () => {
  it("同じクエリ・同じ結果なら true", () => {
    const left = new AggregateQuerySnapshot(makeQuery("users"), { count: 10 });
    const right = new AggregateQuerySnapshot(makeQuery("users"), { count: 10 });
    expect(aggregateQuerySnapshotEqual(left, right)).toBe(true);
  });

  it("クエリが異なると false", () => {
    const left = new AggregateQuerySnapshot(makeQuery("users"), { count: 10 });
    const right = new AggregateQuerySnapshot(makeQuery("posts"), { count: 10 });
    expect(aggregateQuerySnapshotEqual(left, right)).toBe(false);
  });

  it("集計結果が異なると false", () => {
    const left = new AggregateQuerySnapshot(makeQuery("users"), { count: 10 });
    const right = new AggregateQuerySnapshot(makeQuery("users"), { count: 11 });
    expect(aggregateQuerySnapshotEqual(left, right)).toBe(false);
  });
});
