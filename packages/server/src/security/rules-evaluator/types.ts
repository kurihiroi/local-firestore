/**
 * Firestore Security Rules のランタイム値型
 *
 * 各型は typeName フィールドで識別され、is 演算子の判定に使われる。
 */

export interface RulesBool {
  typeName: "bool";
  value: boolean;
}

export interface RulesInt {
  typeName: "int";
  value: number;
}

export interface RulesFloat {
  typeName: "float";
  value: number;
}

export interface RulesString {
  typeName: "string";
  value: string;
}

export interface RulesBytes {
  typeName: "bytes";
  value: Uint8Array;
}

export interface RulesNull {
  typeName: "null";
}

export interface RulesList {
  typeName: "list";
  value: RulesValue[];
}

export interface RulesMap {
  typeName: "map";
  value: Map<string, RulesValue>;
}

export interface RulesSet {
  typeName: "set";
  value: Set<string>;
  /** 元の RulesValue を保持（文字列以外の要素に対応） */
  elements: RulesValue[];
}

export interface RulesTimestamp {
  typeName: "timestamp";
  value: Date;
}

export interface RulesDuration {
  typeName: "duration";
  /** ナノ秒単位の値 */
  nanos: number;
}

export interface RulesLatLng {
  typeName: "latlng";
  latitude: number;
  longitude: number;
}

export interface RulesPath {
  typeName: "path";
  value: string;
}

export interface RulesMapDiff {
  typeName: "map_diff";
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
  unchanged: Set<string>;
}

export type RulesValue =
  | RulesBool
  | RulesInt
  | RulesFloat
  | RulesString
  | RulesBytes
  | RulesNull
  | RulesList
  | RulesMap
  | RulesSet
  | RulesTimestamp
  | RulesDuration
  | RulesLatLng
  | RulesPath
  | RulesMapDiff;

// ─── ヘルパー関数 ───

export function mkBool(value: boolean): RulesBool {
  return { typeName: "bool", value };
}

export function mkInt(value: number): RulesInt {
  return { typeName: "int", value: Math.trunc(value) };
}

export function mkFloat(value: number): RulesFloat {
  return { typeName: "float", value };
}

export function mkString(value: string): RulesString {
  return { typeName: "string", value };
}

export function mkBytes(value: Uint8Array): RulesBytes {
  return { typeName: "bytes", value };
}

export function mkNull(): RulesNull {
  return { typeName: "null" };
}

export function mkList(value: RulesValue[]): RulesList {
  return { typeName: "list", value };
}

export function mkMap(value: Map<string, RulesValue>): RulesMap {
  return { typeName: "map", value };
}

export function mkMapFromObject(obj: Record<string, unknown>): RulesMap {
  const map = new Map<string, RulesValue>();
  for (const [key, val] of Object.entries(obj)) {
    map.set(key, toRulesValue(val));
  }
  return { typeName: "map", value: map };
}

export function mkSet(elements: RulesValue[]): RulesSet {
  const strSet = new Set<string>();
  for (const el of elements) {
    strSet.add(rulesValueToString(el));
  }
  return { typeName: "set", value: strSet, elements };
}

export function mkTimestamp(date: Date): RulesTimestamp {
  return { typeName: "timestamp", value: date };
}

export function mkDuration(nanos: number): RulesDuration {
  return { typeName: "duration", nanos };
}

export function mkLatLng(latitude: number, longitude: number): RulesLatLng {
  return { typeName: "latlng", latitude, longitude };
}

export function mkPath(value: string): RulesPath {
  return { typeName: "path", value };
}

export function mkMapDiff(
  added: Set<string>,
  removed: Set<string>,
  changed: Set<string>,
  unchanged: Set<string>,
): RulesMapDiff {
  return { typeName: "map_diff", added, removed, changed, unchanged };
}

/** JS の値を RulesValue に変換する */
export function toRulesValue(val: unknown): RulesValue {
  if (val === null || val === undefined) return mkNull();
  if (typeof val === "boolean") return mkBool(val);
  if (typeof val === "number") {
    return Number.isInteger(val) ? mkInt(val) : mkFloat(val);
  }
  if (typeof val === "string") return mkString(val);
  if (val instanceof Date) return mkTimestamp(val);
  if (val instanceof Uint8Array) return mkBytes(val);
  if (Array.isArray(val)) return mkList(val.map(toRulesValue));
  if (typeof val === "object") {
    const map = new Map<string, RulesValue>();
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      map.set(k, toRulesValue(v));
    }
    return mkMap(map);
  }
  return mkNull();
}

/** RulesValue を文字列表現に変換（Set のキー等に使用） */
export function rulesValueToString(val: RulesValue): string {
  switch (val.typeName) {
    case "bool":
      return String(val.value);
    case "int":
    case "float":
      return String(val.value);
    case "string":
      return val.value;
    case "null":
      return "null";
    case "path":
      return val.value;
    case "bytes":
      return Array.from(val.value)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    case "timestamp":
      return val.value.toISOString();
    case "duration":
      return `${val.nanos}ns`;
    case "latlng":
      return `[${val.latitude}, ${val.longitude}]`;
    case "list":
      return `[${val.value.map(rulesValueToString).join(", ")}]`;
    case "map":
      return `{${Array.from(val.value.entries())
        .map(([k, v]) => `${k}: ${rulesValueToString(v)}`)
        .join(", ")}}`;
    case "set":
      return `{${Array.from(val.value).join(", ")}}`;
    case "map_diff":
      return "[MapDiff]";
  }
}

/** RulesValue の等値比較 */
export function rulesValueEquals(a: RulesValue, b: RulesValue): boolean {
  if (a.typeName === "null" && b.typeName === "null") return true;
  if (a.typeName !== b.typeName) {
    // int と float の比較
    if (
      (a.typeName === "int" || a.typeName === "float") &&
      (b.typeName === "int" || b.typeName === "float")
    ) {
      return a.value === b.value;
    }
    return false;
  }

  switch (a.typeName) {
    case "bool":
      return a.value === (b as RulesBool).value;
    case "int":
    case "float":
      return a.value === (b as RulesInt | RulesFloat).value;
    case "string":
      return a.value === (b as RulesString).value;
    case "path":
      return a.value === (b as RulesPath).value;
    case "null":
      return true;
    case "bytes": {
      const bb = b as RulesBytes;
      if (a.value.length !== bb.value.length) return false;
      return a.value.every((v, i) => v === bb.value[i]);
    }
    case "timestamp":
      return a.value.getTime() === (b as RulesTimestamp).value.getTime();
    case "duration":
      return a.nanos === (b as RulesDuration).nanos;
    case "latlng":
      return a.latitude === (b as RulesLatLng).latitude && a.longitude === (b as RulesLatLng).longitude;
    case "list": {
      const bl = b as RulesList;
      if (a.value.length !== bl.value.length) return false;
      return a.value.every((v, i) => rulesValueEquals(v, bl.value[i]));
    }
    case "map": {
      const bm = b as RulesMap;
      if (a.value.size !== bm.value.size) return false;
      for (const [k, v] of a.value) {
        const bv = bm.value.get(k);
        if (!bv || !rulesValueEquals(v, bv)) return false;
      }
      return true;
    }
    case "set": {
      const bs = b as RulesSet;
      if (a.value.size !== bs.value.size) return false;
      for (const v of a.value) {
        if (!bs.value.has(v)) return false;
      }
      return true;
    }
    case "map_diff":
      return false;
  }
}

/** 数値比較用: RulesValue から数値を取得。数値でなければ null */
export function toNumber(val: RulesValue): number | null {
  if (val.typeName === "int" || val.typeName === "float") return val.value;
  return null;
}

/** is 演算子の型名チェック */
export function isTypeName(val: RulesValue, typeName: string): boolean {
  if (typeName === "number") {
    return val.typeName === "int" || val.typeName === "float";
  }
  return val.typeName === typeName;
}
