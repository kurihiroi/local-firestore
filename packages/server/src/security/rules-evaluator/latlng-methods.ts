import {
  type RulesLatLng,
  type RulesValue,
  mkFloat,
  mkLatLng,
} from "./types.js";

/**
 * LatLng 型のメソッドをディスパッチする
 */
export function callLatLngMethod(
  latlng: RulesLatLng,
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "latitude":
      assertArgCount("latitude", args, 0);
      return mkFloat(latlng.latitude);

    case "longitude":
      assertArgCount("longitude", args, 0);
      return mkFloat(latlng.longitude);

    case "distance": {
      assertArgCount("distance", args, 1);
      if (args[0].typeName !== "latlng") {
        throw new Error("distance() argument must be a latlng");
      }
      const other = args[0];
      return mkFloat(haversineDistance(latlng, other));
    }

    default:
      throw new Error(`Unknown latlng method: ${method}`);
  }
}

/**
 * latlng namespace 関数
 */
export function callLatLngNamespace(
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "value": {
      if (args.length !== 2) {
        throw new Error("latlng.value() expects 2 arguments (latitude, longitude)");
      }
      const lat = assertNumber(args[0], "latitude");
      const lng = assertNumber(args[1], "longitude");
      return mkLatLng(lat, lng);
    }
    default:
      throw new Error(`Unknown latlng namespace function: ${method}`);
  }
}

/** Haversine公式による2点間の距離（メートル） */
function haversineDistance(a: RulesLatLng, b: RulesLatLng): number {
  const R = 6_371_000; // 地球の半径（メートル）
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const aVal =
    sinDLat * sinDLat + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertNumber(val: RulesValue, label: string): number {
  if (val.typeName === "int" || val.typeName === "float") return val.value;
  throw new Error(`${label} must be a number, got ${val.typeName}`);
}
