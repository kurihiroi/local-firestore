import {
  type RulesMap,
  type RulesMapDiff,
  type RulesValue,
  mkInt,
  mkList,
  mkMapDiff,
  mkSet,
  mkString,
  rulesValueEquals,
} from "./types.js";

/**
 * Map 型のメソッドをディスパッチする
 */
export function callMapMethod(
  map: Map<string, RulesValue>,
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "size":
      return mkInt(map.size);

    case "keys": {
      assertArgCount("keys", args, 0);
      return mkList(Array.from(map.keys()).map(mkString));
    }

    case "values": {
      assertArgCount("values", args, 0);
      return mkList(Array.from(map.values()));
    }

    case "get": {
      if (args.length < 1 || args.length > 2) {
        throw new Error("map.get() expects 1 or 2 arguments");
      }
      if (args[0].typeName !== "string") {
        throw new Error("map.get() key must be a string");
      }
      const key = args[0].value;
      const val = map.get(key);
      if (val !== undefined) return val;
      if (args.length === 2) return args[1];
      throw new Error(`Key '${key}' not found in map`);
    }

    case "diff": {
      assertArgCount("diff", args, 1);
      if (args[0].typeName !== "map") {
        throw new Error("map.diff() argument must be a map");
      }
      return computeMapDiff(map, args[0].value);
    }

    default:
      throw new Error(`Unknown map method: ${method}`);
  }
}

/**
 * MapDiff 型のメソッドをディスパッチする
 */
export function callMapDiffMethod(
  diff: RulesMapDiff,
  method: string,
  args: RulesValue[],
): RulesValue {
  assertArgCount(method, args, 0);

  switch (method) {
    case "addedKeys":
      return mkSet(Array.from(diff.added).map(mkString));

    case "removedKeys":
      return mkSet(Array.from(diff.removed).map(mkString));

    case "changedKeys":
      return mkSet(Array.from(diff.changed).map(mkString));

    case "unchangedKeys":
      return mkSet(Array.from(diff.unchanged).map(mkString));

    case "affectedKeys": {
      const affected = new Set([...diff.added, ...diff.removed, ...diff.changed]);
      return mkSet(Array.from(affected).map(mkString));
    }

    default:
      throw new Error(`Unknown MapDiff method: ${method}`);
  }
}

function computeMapDiff(
  oldMap: Map<string, RulesValue>,
  newMap: Map<string, RulesValue>,
): RulesMapDiff {
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  const unchanged = new Set<string>();

  // oldMap にあるキーを検査
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (newVal === undefined) {
      removed.add(key);
    } else if (rulesValueEquals(oldVal, newVal)) {
      unchanged.add(key);
    } else {
      changed.add(key);
    }
  }

  // newMap にのみあるキー
  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) {
      added.add(key);
    }
  }

  return mkMapDiff(added, removed, changed, unchanged);
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}
