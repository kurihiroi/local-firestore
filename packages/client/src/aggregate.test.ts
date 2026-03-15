import { describe, expect, it } from "vitest";
import { AggregateField, AggregateQuerySnapshot, average, count, sum } from "./aggregate.js";

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
