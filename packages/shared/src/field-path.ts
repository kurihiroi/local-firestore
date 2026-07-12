/**
 * フィールドパス文字列（ドット区切り + バッククォートエスケープ）の
 * フォーマット / パース。
 *
 * 本家 Firestore はフィールド名に任意の文字を許容し、単純形式
 * （`[_a-zA-Z][_a-zA-Z0-9]*`）以外のセグメントはバッククォートで
 * 囲んで表現する（例: `` `with-dash` ``、`` `a.b` `` はドットを含む
 * 単一フィールド名）。バッククォート内では `\\` と `` \` `` が
 * エスケープシーケンスになる。
 *
 * クライアント（FieldPath.toString）・サーバー（SQL の JSON パス構築）・
 * ローカル評価（query-matcher / mutation-applier）で同一実装を共有する。
 */

/** バッククォート不要の単純セグメント（本家 SDK と同じ判定） */
const SIMPLE_SEGMENT_PATTERN = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/** セグメント配列をドット区切りのフィールドパス文字列へ変換する */
export function formatFieldPath(segments: readonly string[]): string {
  return segments
    .map((segment) =>
      SIMPLE_SEGMENT_PATTERN.test(segment)
        ? segment
        : `\`${segment.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``,
    )
    .join(".");
}

/**
 * フィールドパス文字列をセグメント配列へ分解する。
 * バッククォートで囲まれた区間内のドットは区切りとして扱わない。
 * バッククォートを含まない従来のドット記法はそのまま分割される。
 */
export function parseFieldPath(fieldPath: string): string[] {
  if (!fieldPath.includes("`")) {
    return fieldPath.split(".");
  }

  const segments: string[] = [];
  let current = "";
  let inBacktick = false;
  for (let i = 0; i < fieldPath.length; i++) {
    const ch = fieldPath[i];
    if (inBacktick) {
      if (ch === "\\" && i + 1 < fieldPath.length) {
        current += fieldPath[i + 1];
        i++;
      } else if (ch === "`") {
        inBacktick = false;
      } else {
        current += ch;
      }
    } else if (ch === "`") {
      inBacktick = true;
    } else if (ch === ".") {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}
