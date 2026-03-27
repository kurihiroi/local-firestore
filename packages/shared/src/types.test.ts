import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./types.js";

describe("ERROR_CODES", () => {
  it("全てのgRPCステータスコードが定義されている", () => {
    expect(ERROR_CODES.CANCELLED).toBe("cancelled");
    expect(ERROR_CODES.UNKNOWN).toBe("unknown");
    expect(ERROR_CODES.INVALID_ARGUMENT).toBe("invalid-argument");
    expect(ERROR_CODES.DEADLINE_EXCEEDED).toBe("deadline-exceeded");
    expect(ERROR_CODES.NOT_FOUND).toBe("not-found");
    expect(ERROR_CODES.ALREADY_EXISTS).toBe("already-exists");
    expect(ERROR_CODES.PERMISSION_DENIED).toBe("permission-denied");
    expect(ERROR_CODES.RESOURCE_EXHAUSTED).toBe("resource-exhausted");
    expect(ERROR_CODES.FAILED_PRECONDITION).toBe("failed-precondition");
    expect(ERROR_CODES.ABORTED).toBe("aborted");
    expect(ERROR_CODES.OUT_OF_RANGE).toBe("out-of-range");
    expect(ERROR_CODES.UNIMPLEMENTED).toBe("unimplemented");
    expect(ERROR_CODES.INTERNAL).toBe("internal");
    expect(ERROR_CODES.UNAVAILABLE).toBe("unavailable");
    expect(ERROR_CODES.DATA_LOSS).toBe("data-loss");
    expect(ERROR_CODES.UNAUTHENTICATED).toBe("unauthenticated");
  });

  it("16個のエラーコードが定義されている", () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(16);
  });

  it("各値がユニークである", () => {
    const values = Object.values(ERROR_CODES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});
