import { describe, expect, it } from "vitest";
import {
  MAX_DISJUNCTION_VALUES,
  MAX_NOT_IN_VALUES,
  validateQueryFilters,
} from "./query-validation.js";
import type { SerializedQueryConstraint, WhereFilterOp } from "./types.js";

function whereC(op: WhereFilterOp, value: unknown, fieldPath = "f"): SerializedQueryConstraint {
  return { type: "where", fieldPath, op, value };
}

describe("validateQueryFilters", () => {
  it("should allow valid queries", () => {
    expect(validateQueryFilters([whereC("==", 1)])).toBeNull();
    expect(validateQueryFilters([whereC("in", [1, 2, 3])])).toBeNull();
    expect(validateQueryFilters([whereC("array-contains", 1)])).toBeNull();
    expect(validateQueryFilters([])).toBeNull();
  });

  it("should reject in / array-contains-any with more than 30 elements", () => {
    const tooMany = Array.from({ length: MAX_DISJUNCTION_VALUES + 1 }, (_, i) => i);
    expect(validateQueryFilters([whereC("in", tooMany)])).toContain("maximum of 30");
    expect(validateQueryFilters([whereC("array-contains-any", tooMany)])).toContain(
      "maximum of 30",
    );
    // ちょうど30要素は許可
    expect(validateQueryFilters([whereC("in", tooMany.slice(0, 30))])).toBeNull();
  });

  it("should reject not-in with more than 10 elements", () => {
    const tooMany = Array.from({ length: MAX_NOT_IN_VALUES + 1 }, (_, i) => i);
    expect(validateQueryFilters([whereC("not-in", tooMany)])).toContain("maximum of 10");
    expect(validateQueryFilters([whereC("not-in", tooMany.slice(0, 10))])).toBeNull();
  });

  it("should reject empty arrays for in / not-in / array-contains-any", () => {
    expect(validateQueryFilters([whereC("in", [])])).toContain("non-empty array");
    expect(validateQueryFilters([whereC("not-in", [])])).toContain("non-empty array");
    expect(validateQueryFilters([whereC("array-contains-any", [])])).toContain("non-empty array");
  });

  it("should reject non-array values for in / not-in / array-contains-any", () => {
    expect(validateQueryFilters([whereC("in", "a")])).toContain("non-empty array");
  });

  it("should reject multiple array-contains filters", () => {
    expect(
      validateQueryFilters([whereC("array-contains", 1, "a"), whereC("array-contains", 2, "b")]),
    ).toContain("more than one 'array-contains'");
  });

  it("should reject multiple not-in filters", () => {
    expect(
      validateQueryFilters([whereC("not-in", [1], "a"), whereC("not-in", [2], "b")]),
    ).toContain("more than one 'not-in'");
  });

  it("should reject not-in combined with !=", () => {
    expect(validateQueryFilters([whereC("not-in", [1], "a"), whereC("!=", 2, "b")])).toContain(
      "'not-in' filters with '!='",
    );
  });

  it("should reject not-in combined with in / array-contains-any", () => {
    expect(validateQueryFilters([whereC("not-in", [1], "a"), whereC("in", [2], "b")])).toContain(
      "'not-in' filters with 'in'",
    );
    expect(
      validateQueryFilters([whereC("not-in", [1], "a"), whereC("array-contains-any", [2], "b")]),
    ).toContain("'not-in' filters with 'array-contains-any'");
  });

  it("should validate filters inside and/or composite constraints", () => {
    const composite: SerializedQueryConstraint = {
      type: "and",
      filters: [
        { type: "where", fieldPath: "a", op: "array-contains", value: 1 },
        { type: "where", fieldPath: "b", op: "array-contains", value: 2 },
      ],
    };
    expect(validateQueryFilters([composite])).toContain("more than one 'array-contains'");
  });
});
