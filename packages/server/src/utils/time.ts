/**
 * マイクロ秒精度の現在時刻を ISO 8601 文字列で返す
 *
 * 本家 Firestore の createTime / updateTime はマイクロ秒精度のため、
 * `new Date().toISOString()`（ミリ秒精度）ではなく
 * `performance.timeOrigin + performance.now()` からマイクロ秒を導出する。
 * 形式: `YYYY-MM-DDTHH:mm:ss.ssssssZ`（小数6桁）
 */
export function nowIsoMicros(): string {
  const epochMicros = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  const epochMs = Math.floor(epochMicros / 1000);
  const micros = epochMicros % 1_000_000;
  const base = new Date(epochMs - (epochMs % 1000)).toISOString().slice(0, -5); // "YYYY-MM-DDTHH:mm:ss"
  return `${base}.${String(micros).padStart(6, "0")}Z`;
}
