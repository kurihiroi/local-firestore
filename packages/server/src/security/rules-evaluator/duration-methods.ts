import { mkDuration, mkInt, type RulesValue } from "./types.js";

const NANOS_PER_SECOND = 1_000_000_000;
const NANOS_PER_MINUTE = 60 * NANOS_PER_SECOND;
const NANOS_PER_HOUR = 60 * NANOS_PER_MINUTE;

/**
 * Duration 型のメソッドをディスパッチする
 */
export function callDurationMethod(nanos: number, method: string, args: RulesValue[]): RulesValue {
  assertArgCount(method, args, 0);

  switch (method) {
    case "nanos":
      return mkInt(nanos);
    case "seconds":
      return mkInt(Math.trunc(nanos / NANOS_PER_SECOND));
    case "minutes":
      return mkInt(Math.trunc(nanos / NANOS_PER_MINUTE));
    case "hours":
      return mkInt(Math.trunc(nanos / NANOS_PER_HOUR));
    default:
      throw new Error(`Unknown duration method: ${method}`);
  }
}

/**
 * duration namespace 関数
 */
export function callDurationNamespace(method: string, args: RulesValue[]): RulesValue {
  switch (method) {
    case "time": {
      if (args.length !== 4) {
        throw new Error("duration.time() expects 4 arguments (hours, minutes, seconds, nanos)");
      }
      const hours = assertInt(args[0], "hours");
      const minutes = assertInt(args[1], "minutes");
      const seconds = assertInt(args[2], "seconds");
      const nanos = assertInt(args[3], "nanos");
      return mkDuration(
        hours * NANOS_PER_HOUR + minutes * NANOS_PER_MINUTE + seconds * NANOS_PER_SECOND + nanos,
      );
    }
    case "value": {
      if (args.length !== 2) {
        throw new Error("duration.value() expects 2 arguments (magnitude, unit)");
      }
      const magnitude = assertInt(args[0], "magnitude");
      if (args[1].typeName !== "string") {
        throw new Error("duration.value() unit must be a string");
      }
      const unit = args[1].value;
      return mkDuration(magnitude * unitToNanos(unit));
    }
    default:
      throw new Error(`Unknown duration namespace function: ${method}`);
  }
}

function unitToNanos(unit: string): number {
  switch (unit) {
    case "w":
      return 7 * 24 * NANOS_PER_HOUR;
    case "d":
      return 24 * NANOS_PER_HOUR;
    case "h":
      return NANOS_PER_HOUR;
    case "m":
      return NANOS_PER_MINUTE;
    case "s":
      return NANOS_PER_SECOND;
    case "ms":
      return 1_000_000;
    case "ns":
      return 1;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`duration.${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertInt(val: RulesValue, label: string): number {
  if (val.typeName !== "int") {
    throw new Error(`${label} must be an int, got ${val.typeName}`);
  }
  return val.value;
}
