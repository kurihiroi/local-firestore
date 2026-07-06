import { describe, expect, it } from "vitest";
import { BuiltinFunctionContext } from "./builtin-functions.js";
import type { EvaluationContext } from "./context.js";
import { RulesEvaluator } from "./evaluator.js";
import { documentValueToRulesValue } from "./special-types.js";

function makeEvalContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    auth: null,
    path: "posts/post1",
    documentId: "post1",
    collectionPath: "posts",
    operation: "get",
    requestTime: new Date("2025-01-01T00:00:00Z"),
    wildcardBindings: {},
    ...overrides,
  };
}

function createEvaluator(): RulesEvaluator {
  return new RulesEvaluator(new BuiltinFunctionContext(null));
}

/** __type ラッパー付きの Timestamp を生成 */
function serializedTimestamp(date: Date) {
  const millis = date.getTime();
  return {
    __type: "timestamp",
    value: {
      seconds: Math.floor(millis / 1000),
      nanoseconds: (millis % 1000) * 1_000_000,
    },
  };
}

describe("documentValueToRulesValue", () => {
  it("should convert timestamp wrapper to RulesTimestamp", () => {
    const val = documentValueToRulesValue({
      __type: "timestamp",
      value: { seconds: 1735689600, nanoseconds: 500_000_000 },
    });
    expect(val.typeName).toBe("timestamp");
    if (val.typeName === "timestamp") {
      expect(val.value.getTime()).toBe(1735689600_000 + 500);
    }
  });

  it("should convert geopoint wrapper to RulesLatLng", () => {
    const val = documentValueToRulesValue({
      __type: "geopoint",
      value: { latitude: 35.68, longitude: 139.69 },
    });
    expect(val.typeName).toBe("latlng");
    if (val.typeName === "latlng") {
      expect(val.latitude).toBe(35.68);
      expect(val.longitude).toBe(139.69);
    }
  });

  it("should convert bytes wrapper to RulesBytes", () => {
    const val = documentValueToRulesValue({
      __type: "bytes",
      value: Buffer.from("hello").toString("base64"),
    });
    expect(val.typeName).toBe("bytes");
    if (val.typeName === "bytes") {
      expect(Buffer.from(val.value).toString("utf8")).toBe("hello");
    }
  });

  it("should convert reference wrapper to RulesPath", () => {
    const val = documentValueToRulesValue({ __type: "reference", value: "users/u1" });
    expect(val.typeName).toBe("path");
    if (val.typeName === "path") {
      expect(val.value).toBe("/databases/(default)/documents/users/u1");
    }
  });

  it("should convert vector wrapper to RulesList", () => {
    const val = documentValueToRulesValue({ __type: "vector", values: [1, 2.5] });
    expect(val.typeName).toBe("list");
    if (val.typeName === "list") {
      expect(val.value).toHaveLength(2);
      expect(val.value[0].typeName).toBe("float");
    }
  });

  it("should convert nested wrappers inside maps and arrays", () => {
    const val = documentValueToRulesValue({
      meta: { createdAt: serializedTimestamp(new Date("2025-06-01T00:00:00Z")) },
      points: [{ __type: "geopoint", value: { latitude: 1, longitude: 2 } }],
    });
    expect(val.typeName).toBe("map");
    if (val.typeName === "map") {
      const meta = val.value.get("meta");
      expect(meta?.typeName).toBe("map");
      if (meta?.typeName === "map") {
        expect(meta.value.get("createdAt")?.typeName).toBe("timestamp");
      }
      const points = val.value.get("points");
      expect(points?.typeName).toBe("list");
      if (points?.typeName === "list") {
        expect(points.value[0].typeName).toBe("latlng");
      }
    }
  });

  it("should keep plain maps (without __type) as maps", () => {
    const val = documentValueToRulesValue({ seconds: 1, nanoseconds: 2 });
    expect(val.typeName).toBe("map");
  });

  it("should keep maps with unknown __type as maps", () => {
    const val = documentValueToRulesValue({ __type: "unknown", value: 1 });
    expect(val.typeName).toBe("map");
  });
});

describe("special types in rule expressions", () => {
  it("should evaluate `is timestamp` on resource.data", () => {
    const evaluator = createEvaluator();
    expect(
      evaluator.evaluateExpression(
        "resource.data.createdAt is timestamp",
        makeEvalContext({
          existingData: { createdAt: serializedTimestamp(new Date("2024-12-01T00:00:00Z")) },
        }),
      ),
    ).toBe(true);
  });

  it("should compare resource.data timestamp with request.time", () => {
    const evaluator = createEvaluator();
    const ctx = makeEvalContext({
      existingData: { createdAt: serializedTimestamp(new Date("2024-12-01T00:00:00Z")) },
    });
    expect(evaluator.evaluateExpression("resource.data.createdAt < request.time", ctx)).toBe(true);
    expect(evaluator.evaluateExpression("resource.data.createdAt > request.time", ctx)).toBe(false);
  });

  it("should call timestamp methods on resource.data", () => {
    const evaluator = createEvaluator();
    const date = new Date("2024-12-01T10:30:00Z");
    const ctx = makeEvalContext({ existingData: { createdAt: serializedTimestamp(date) } });
    expect(
      evaluator.evaluateExpression(`resource.data.createdAt.toMillis() == ${date.getTime()}`, ctx),
    ).toBe(true);
    expect(evaluator.evaluateExpression("resource.data.createdAt.year() == 2024", ctx)).toBe(true);
  });

  it("should add duration to resource.data timestamp", () => {
    const evaluator = createEvaluator();
    const ctx = makeEvalContext({
      requestTime: new Date("2025-01-01T00:00:00Z"),
      existingData: { createdAt: serializedTimestamp(new Date("2024-12-31T00:00:00Z")) },
    });
    // createdAt + 2日 > request.time（1日後）
    expect(
      evaluator.evaluateExpression(
        "resource.data.createdAt + duration.value(2, 'd') > request.time",
        ctx,
      ),
    ).toBe(true);
  });

  it("should evaluate `is latlng` and latlng accessors on request.resource.data", () => {
    const evaluator = createEvaluator();
    const ctx = makeEvalContext({
      operation: "create",
      requestData: {
        location: { __type: "geopoint", value: { latitude: 35.68, longitude: 139.69 } },
      },
    });
    expect(evaluator.evaluateExpression("request.resource.data.location is latlng", ctx)).toBe(
      true,
    );
    expect(
      evaluator.evaluateExpression("request.resource.data.location.latitude() > 35.0", ctx),
    ).toBe(true);
  });

  it("should evaluate bytes size on resource.data", () => {
    const evaluator = createEvaluator();
    const ctx = makeEvalContext({
      existingData: {
        payload: { __type: "bytes", value: Buffer.from("hello").toString("base64") },
      },
    });
    expect(evaluator.evaluateExpression("resource.data.payload is bytes", ctx)).toBe(true);
    expect(evaluator.evaluateExpression("resource.data.payload.size() == 5", ctx)).toBe(true);
  });

  it("should evaluate reference as path", () => {
    const evaluator = createEvaluator();
    const ctx = makeEvalContext({
      existingData: { owner: { __type: "reference", value: "users/u1" } },
    });
    expect(evaluator.evaluateExpression("resource.data.owner is path", ctx)).toBe(true);
    expect(
      evaluator.evaluateExpression(
        "resource.data.owner == path('/databases/(default)/documents/users/u1')",
        ctx,
      ),
    ).toBe(true);
  });
});
