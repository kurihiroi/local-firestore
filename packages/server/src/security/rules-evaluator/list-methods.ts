import {
  mkBool,
  mkInt,
  mkList,
  mkSet,
  mkString,
  type RulesValue,
  rulesValueEquals,
  rulesValueToString,
} from "./types.js";

/**
 * List 型のメソッドをディスパッチする
 */
export function callListMethod(list: RulesValue[], method: string, args: RulesValue[]): RulesValue {
  switch (method) {
    case "size":
      return mkInt(list.length);

    case "hasAny": {
      assertArgCount("hasAny", args, 1);
      const other = assertList(args[0], "hasAny argument");
      return mkBool(other.some((item) => list.some((el) => rulesValueEquals(el, item))));
    }

    case "hasAll": {
      assertArgCount("hasAll", args, 1);
      const other = assertList(args[0], "hasAll argument");
      return mkBool(other.every((item) => list.some((el) => rulesValueEquals(el, item))));
    }

    case "hasOnly": {
      assertArgCount("hasOnly", args, 1);
      const allowed = assertList(args[0], "hasOnly argument");
      return mkBool(list.every((item) => allowed.some((el) => rulesValueEquals(el, item))));
    }

    case "toSet": {
      assertArgCount("toSet", args, 0);
      return mkSet(list);
    }

    case "join": {
      assertArgCount("join", args, 1);
      if (args[0].typeName !== "string") {
        throw new Error("join() separator must be a string");
      }
      const separator = args[0].value;
      const parts = list.map(rulesValueToString);
      return mkString(parts.join(separator));
    }

    case "concat": {
      assertArgCount("concat", args, 1);
      const other = assertList(args[0], "concat argument");
      return mkList([...list, ...other]);
    }

    case "removeAll": {
      assertArgCount("removeAll", args, 1);
      const toRemove = assertList(args[0], "removeAll argument");
      const filtered = list.filter((item) => !toRemove.some((r) => rulesValueEquals(item, r)));
      return mkList(filtered);
    }

    default:
      throw new Error(`Unknown list method: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertList(val: RulesValue, label: string): RulesValue[] {
  if (val.typeName !== "list") {
    throw new Error(`${label} must be a list, got ${val.typeName}`);
  }
  return val.value;
}
