import {
  type RulesValue,
  mkBool,
  mkBytes,
  mkInt,
  mkList,
  mkString,
} from "./types.js";

/**
 * String 型のメソッドをディスパッチする
 */
export function callStringMethod(
  str: string,
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "size":
      return mkInt(str.length);

    case "matches": {
      assertArgCount("matches", args, 1);
      const pattern = assertString(args[0], "matches argument");
      try {
        const regex = new RegExp(pattern);
        return mkBool(regex.test(str));
      } catch {
        throw new Error(`Invalid regex pattern: ${pattern}`);
      }
    }

    case "split": {
      assertArgCount("split", args, 1);
      const separator = assertString(args[0], "split argument");
      const parts = str.split(separator);
      return mkList(parts.map(mkString));
    }

    case "trim":
      assertArgCount("trim", args, 0);
      return mkString(str.trim());

    case "lower":
      assertArgCount("lower", args, 0);
      return mkString(str.toLowerCase());

    case "upper":
      assertArgCount("upper", args, 0);
      return mkString(str.toUpperCase());

    case "replace": {
      assertArgCount("replace", args, 2);
      const pattern = assertString(args[0], "replace pattern");
      const replacement = assertString(args[1], "replace replacement");
      try {
        const regex = new RegExp(pattern, "g");
        return mkString(str.replace(regex, replacement));
      } catch {
        throw new Error(`Invalid regex pattern: ${pattern}`);
      }
    }

    case "contains": {
      assertArgCount("contains", args, 1);
      const substring = assertString(args[0], "contains argument");
      return mkBool(str.includes(substring));
    }

    case "startsWith": {
      assertArgCount("startsWith", args, 1);
      const prefix = assertString(args[0], "startsWith argument");
      return mkBool(str.startsWith(prefix));
    }

    case "endsWith": {
      assertArgCount("endsWith", args, 1);
      const suffix = assertString(args[0], "endsWith argument");
      return mkBool(str.endsWith(suffix));
    }

    case "toUtf8": {
      assertArgCount("toUtf8", args, 0);
      const encoder = new TextEncoder();
      return mkBytes(encoder.encode(str));
    }

    default:
      throw new Error(`Unknown string method: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertString(val: RulesValue, label: string): string {
  if (val.typeName !== "string") {
    throw new Error(`${label} must be a string, got ${val.typeName}`);
  }
  return val.value;
}
