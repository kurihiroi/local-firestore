import {
  mkBool,
  mkInt,
  mkSet,
  type RulesSet,
  type RulesValue,
  rulesValueToString,
} from "./types.js";

/**
 * Set 型のメソッドをディスパッチする
 */
export function callSetMethod(
  set: Set<string>,
  elements: RulesValue[],
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "size":
      assertArgCount("size", args, 0);
      return mkInt(set.size);

    case "hasAny": {
      assertArgCount("hasAny", args, 1);
      const other = assertSetOrList(args[0], "hasAny argument");
      return mkBool(other.some((v) => set.has(rulesValueToString(v))));
    }

    case "hasAll": {
      assertArgCount("hasAll", args, 1);
      const other = assertSetOrList(args[0], "hasAll argument");
      return mkBool(other.every((v) => set.has(rulesValueToString(v))));
    }

    case "hasOnly": {
      assertArgCount("hasOnly", args, 1);
      const allowed = assertSetOrList(args[0], "hasOnly argument");
      const allowedSet = new Set(allowed.map(rulesValueToString));
      for (const v of set) {
        if (!allowedSet.has(v)) return mkBool(false);
      }
      return mkBool(true);
    }

    case "union": {
      assertArgCount("union", args, 1);
      const other = assertSetValues(args[0], "union argument");
      const newSet = new Set(set);
      const newElements = [...elements];
      for (const v of other.elements) {
        const str = rulesValueToString(v);
        if (!newSet.has(str)) {
          newSet.add(str);
          newElements.push(v);
        }
      }
      return { typeName: "set", value: newSet, elements: newElements };
    }

    case "intersection": {
      assertArgCount("intersection", args, 1);
      const other = assertSetValues(args[0], "intersection argument");
      const result: RulesValue[] = [];
      for (const v of elements) {
        if (other.value.has(rulesValueToString(v))) {
          result.push(v);
        }
      }
      return mkSet(result);
    }

    case "difference": {
      assertArgCount("difference", args, 1);
      const other = assertSetValues(args[0], "difference argument");
      const result: RulesValue[] = [];
      for (const v of elements) {
        if (!other.value.has(rulesValueToString(v))) {
          result.push(v);
        }
      }
      return mkSet(result);
    }

    default:
      throw new Error(`Unknown set method: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertSetOrList(val: RulesValue, label: string): RulesValue[] {
  if (val.typeName === "set") return val.elements;
  if (val.typeName === "list") return val.value;
  throw new Error(`${label} must be a set or list, got ${val.typeName}`);
}

function assertSetValues(val: RulesValue, label: string): RulesSet {
  if (val.typeName !== "set") {
    throw new Error(`${label} must be a set, got ${val.typeName}`);
  }
  return val;
}
