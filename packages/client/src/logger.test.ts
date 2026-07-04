import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogLevel, logDebug, logError, setLogLevel } from "./logger.js";

describe("setLogLevel()", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLogLevel("error");
    vi.restoreAllMocks();
  });

  it("デフォルトのログレベルは error", () => {
    expect(getLogLevel()).toBe("error");
  });

  it("error レベルでは debug ログが出力されない", () => {
    setLogLevel("error");
    logDebug("debug message");
    logError("error message");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[Firestore] error message");
  });

  it("debug レベルでは debug と error の両方が出力される", () => {
    setLogLevel("debug");
    logDebug("debug message");
    logError("error message");
    expect(console.debug).toHaveBeenCalledWith("[Firestore] debug message");
    expect(console.error).toHaveBeenCalledWith("[Firestore] error message");
  });

  it("silent レベルでは何も出力されない", () => {
    setLogLevel("silent");
    logDebug("debug message");
    logError("error message");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
