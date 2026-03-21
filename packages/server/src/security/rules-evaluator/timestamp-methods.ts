import {
  type RulesValue,
  mkInt,
  mkTimestamp,
} from "./types.js";

/**
 * Timestamp 型のメソッドをディスパッチする
 */
export function callTimestampMethod(
  date: Date,
  method: string,
  args: RulesValue[],
): RulesValue {
  assertArgCount(method, args, 0);

  switch (method) {
    case "year":
      return mkInt(date.getUTCFullYear());
    case "month":
      return mkInt(date.getUTCMonth() + 1); // 1-12
    case "day":
      return mkInt(date.getUTCDate()); // 1-31
    case "hours":
      return mkInt(date.getUTCHours()); // 0-23
    case "minutes":
      return mkInt(date.getUTCMinutes()); // 0-59
    case "seconds":
      return mkInt(date.getUTCSeconds()); // 0-59
    case "nanos":
      return mkInt(date.getUTCMilliseconds() * 1_000_000);
    case "dayOfWeek":
      // Firestore: 1=Sunday, 7=Saturday
      return mkInt(date.getUTCDay() + 1);
    case "dayOfYear": {
      const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const diff = date.getTime() - start.getTime();
      return mkInt(Math.floor(diff / 86_400_000) + 1);
    }
    case "toMillis":
      return mkInt(date.getTime());
    case "date":
      // date() メソッドは年月日のみのTimestampを返す
      return mkTimestamp(
        new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
      );
    default:
      throw new Error(`Unknown timestamp method: ${method}`);
  }
}

/**
 * timestamp namespace 関数
 */
export function callTimestampNamespace(
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "date": {
      if (args.length !== 3) throw new Error("timestamp.date() expects 3 arguments (year, month, day)");
      const year = assertInt(args[0], "year");
      const month = assertInt(args[1], "month");
      const day = assertInt(args[2], "day");
      return mkTimestamp(new Date(Date.UTC(year, month - 1, day)));
    }
    case "value": {
      if (args.length !== 1) throw new Error("timestamp.value() expects 1 argument (epoch_ms)");
      const ms = assertInt(args[0], "epoch_ms");
      return mkTimestamp(new Date(ms));
    }
    default:
      throw new Error(`Unknown timestamp namespace function: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`timestamp.${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertInt(val: RulesValue, label: string): number {
  if (val.typeName !== "int") {
    throw new Error(`${label} must be an int, got ${val.typeName}`);
  }
  return val.value;
}
