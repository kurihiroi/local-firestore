import { parseFieldPath } from "./field-path.js";
import { DocumentValidationError } from "./limits.js";
import { isFieldValueSentinel } from "./protocol.js";
import type { DocumentData, SerializedTimestamp, SetOptions } from "./types.js";

/**
 * 書き込みミューテーションの適用ロジック（set / merge set / update）
 *
 * サーバー（DocumentService）とクライアント（レイテンシ補償のローカルビュー合成）で
 * 同一のセマンティクスを共有するために shared に置く。FieldValue センチネルの解決、
 * deep merge、ドット記法パスのリーフ更新、deleteField マーカー処理を含む。
 *
 * serverTimestamp の解決値は MutationContext で注入する
 * （サーバー: 現在時刻 / クライアント: ローカル書き込み時刻の推定値）。
 */

/** ミューテーション適用のコンテキスト */
export interface MutationContext {
  /**
   * serverTimestamp センチネルの解決値を返す。
   *
   * サーバーは確定タイムスタンプを返す。クライアント（レイテンシ補償）は
   * 保留中マーカーを返し、SnapshotOptions.serverTimestamps に応じた解決を
   * 読み取り時に行う。previousValue には既存フィールド値が渡される
   * （'previous' 挙動用）。
   */
  serverTimestamp: (previousValue?: unknown) => unknown;
}

/**
 * serverTimestamp を単一のコミット時刻で解決するコンテキストを作る。
 *
 * 時刻はコンテキスト生成時に 1 回だけ採取され、同一コンテキスト内の
 * すべての serverTimestamp が同じ値に解決される（本家は 1 コミットの
 * 全 serverTimestamp を単一のコミット時刻に統一する）。
 * バッチ / トランザクションではコミット単位で 1 つのコンテキストを共有すること。
 */
export function createServerMutationContext(commitTime: Date = new Date()): MutationContext {
  const resolved: SerializedTimestamp = {
    __type: "timestamp",
    value: {
      seconds: Math.floor(commitTime.getTime() / 1000),
      nanoseconds: (commitTime.getTime() % 1000) * 1_000_000,
    },
  };
  return {
    serverTimestamp: () => ({ __type: "timestamp", value: { ...resolved.value } }),
  };
}

/**
 * deleteField センチネルの内部表現（プロトコルレベル）
 *
 * 文字列表現（旧 "$$__DELETE__$$"）は同じ文字列値の書き込みと衝突するため、
 * 他の特殊型と統一した `{__type: "delete"}` 形式を使う。
 */
interface DeleteMarker {
  __type: "delete";
}

const DELETE_MARKER: DeleteMarker = { __type: "delete" };

/** 値が deleteField マーカーかどうか */
export function isDeleteMarker(value: unknown): value is DeleteMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__type === "delete"
  );
}

/** deleteField マーカーが値の中に含まれるか（ネスト構造も検査） */
function containsDeleteMarker(value: unknown): boolean {
  if (isDeleteMarker(value)) return true;
  if (Array.isArray(value)) return value.some(containsDeleteMarker);
  if (isPlainObject(value) && !isSpecialValueWrapper(value)) {
    return Object.values(value).some(containsDeleteMarker);
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpecialValueWrapper(value: unknown): boolean {
  return isPlainObject(value) && typeof value.__type === "string";
}

/** Firestore の等値セマンティクスに合わせた深い等値比較（arrayUnion / arrayRemove 用） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(a[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** ドット記法パスで既存データから値を取得する */
function getFieldByPath(data: DocumentData | undefined, path: string): unknown {
  if (!data) return undefined;
  if (!path.includes(".") && !path.includes("`")) return data[path];
  let current: unknown = data;
  for (const segment of parseFieldPath(path)) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * ドット記法パスでリーフ値のみを設定/削除する（本家 updateDoc のフィールドパス更新と同じ挙動）
 */
function setFieldByPath(data: DocumentData, path: string, value: unknown): void {
  const segments = parseFieldPath(path);
  let current: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!isPlainObject(current[seg])) {
      if (isDeleteMarker(value)) return; // 存在しないパスの削除は no-op
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (isDeleteMarker(value)) {
    delete current[leaf];
  } else {
    current[leaf] = value;
  }
}

/**
 * FieldValue センチネルを実際の値に解決する
 *
 * ネストしたマップ内のセンチネルや、ドット記法キー（updateDoc の
 * フィールドパス更新）に対する increment / arrayUnion も解決する。
 */
function resolveFieldValues(
  data: DocumentData,
  existingData: DocumentData | undefined,
  ctx: MutationContext,
): DocumentData {
  const resolved: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    const existingValue = getFieldByPath(existingData, key);
    resolved[key] = resolveValue(value, existingValue, ctx);
  }
  return resolved;
}

function resolveValue(value: unknown, existingValue: unknown, ctx: MutationContext): unknown {
  if (isFieldValueSentinel(value)) {
    switch (value.type) {
      case "serverTimestamp":
        return ctx.serverTimestamp(existingValue);
      case "deleteField":
        return DELETE_MARKER;
      case "increment": {
        const current = typeof existingValue === "number" ? existingValue : 0;
        return current + (value.value as number);
      }
      case "arrayUnion": {
        const currentArr = Array.isArray(existingValue) ? existingValue : [];
        const toAdd = value.value as unknown[];
        return [...currentArr, ...toAdd.filter((v) => !currentArr.some((c) => deepEqual(c, v)))];
      }
      case "arrayRemove": {
        const currentArr = Array.isArray(existingValue) ? existingValue : [];
        const toRemove = value.value as unknown[];
        return currentArr.filter((v) => !toRemove.some((r) => deepEqual(r, v)));
      }
    }
  }

  // 特殊型ラッパー（{__type: ...}）の内部には踏み込まない
  // （deleteField マーカーと同じ形式の書き込みデータもここで素通しになるが、
  // マーカーは resolveFieldValues の後段でのみ意味を持つため実害はない）
  if (isSpecialValueWrapper(value)) {
    return value;
  }

  // ネストしたマップ内のセンチネルを再帰的に解決する
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const existingRecord = isPlainObject(existingValue)
      ? (existingValue as Record<string, unknown>)
      : undefined;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = resolveValue(v, existingRecord?.[k], ctx);
    }
    return result;
  }

  return value;
}

/**
 * setDoc の merge オプション用の深いマージ
 *
 * ネストしたマップは再帰的にマージし、それ以外の値（配列・特殊型を含む）は上書きする。
 * deleteField マーカー（{__type: "delete"}）はフィールドを削除する。
 */
function deepMerge(base: DocumentData, updates: DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(updates)) {
    if (isDeleteMarker(value)) {
      delete result[key];
    } else if (
      isPlainObject(value) &&
      !isSpecialValueWrapper(value) &&
      isPlainObject(result[key]) &&
      !isSpecialValueWrapper(result[key])
    ) {
      result[key] = deepMerge(result[key] as DocumentData, value as DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** merge set でドキュメントが存在しない場合に deleteField マーカーを取り除く */
function stripDeleteMarkers(data: DocumentData): DocumentData {
  const result: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (isDeleteMarker(value)) continue;
    if (isPlainObject(value) && !isSpecialValueWrapper(value)) {
      result[key] = stripDeleteMarkers(value as DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Timestamp のナノ秒をマイクロ秒精度へ切り捨てる（本家仕様） */
function truncateTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((v) => {
      const t = truncateTimestamps(v);
      if (t !== v) changed = true;
      return t;
    });
    return changed ? result : value;
  }
  if (isPlainObject(value)) {
    if (value.__type === "timestamp" && isPlainObject(value.value)) {
      const v = value.value as { seconds: number; nanoseconds: number };
      const truncated = Math.floor(v.nanoseconds / 1000) * 1000;
      if (truncated !== v.nanoseconds) {
        return { __type: "timestamp", value: { seconds: v.seconds, nanoseconds: truncated } };
      }
      return value;
    }
    if (isSpecialValueWrapper(value)) return value;
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const t = truncateTimestamps(v);
      if (t !== v) changed = true;
      result[k] = t;
    }
    return changed ? result : value;
  }
  return value;
}

/**
 * set（setDoc / batch set / addDoc）ミューテーションを適用した結果を計算する
 *
 * - センチネル解決（serverTimestamp / deleteField / increment / arrayUnion / arrayRemove）
 * - merge / mergeFields のマージセマンティクス
 * - merge なしの deleteField をエラー（本家準拠、code: invalid-argument）
 * - Timestamp のマイクロ秒切り捨て
 *
 * @param base 既存ドキュメントのデータ（存在しない場合は null）
 */
export function applySetMutation(
  base: DocumentData | null,
  data: DocumentData,
  options: SetOptions | undefined,
  ctx: MutationContext,
): DocumentData {
  const resolvedData = resolveFieldValues(data, base ?? undefined, ctx);

  const isMerge = options !== undefined && ("merge" in options || "mergeFields" in options);
  if (!isMerge && containsDeleteMarker(resolvedData)) {
    // 本家同様、deleteField() は update() または set() の merge オプション時のみ有効
    throw new DocumentValidationError(
      "deleteField() can only be used with update() or set() with {merge: true}",
    );
  }

  let finalData: DocumentData;
  if (options && base) {
    if ("merge" in options && options.merge) {
      // 本家と同様、ネストしたマップは再帰的にマージする
      finalData = deepMerge(base, resolvedData) as DocumentData;
    } else if ("mergeFields" in options) {
      finalData = structuredClone(base);
      for (const field of options.mergeFields) {
        const value = getFieldByPath(resolvedData, field);
        if (value !== undefined) {
          setFieldByPath(finalData, field, value);
        }
      }
    } else {
      finalData = resolvedData;
    }
  } else {
    finalData = isMerge ? stripDeleteMarkers(resolvedData) : resolvedData;
  }

  // 本家仕様: Timestamp はマイクロ秒精度に切り捨てて保存する
  return truncateTimestamps(finalData) as DocumentData;
}

/**
 * update（updateDoc / batch update）ミューテーションを適用した結果を計算する
 *
 * - センチネル解決
 * - ドット記法キーのリーフ更新（兄弟フィールド保持）
 * - ネストしたマップ内の deleteField をエラー（トップレベルのみ有効、本家準拠）
 * - Timestamp のマイクロ秒切り捨て
 *
 * ドキュメントの存在チェックは呼び出し側の責務（サーバー: not-found エラー）。
 */
export function applyUpdateMutation(
  base: DocumentData,
  data: DocumentData,
  ctx: MutationContext,
): DocumentData {
  const mergedData = structuredClone(base);
  const resolvedUpdates = resolveFieldValues(data, base, ctx);

  for (const [key, value] of Object.entries(resolvedUpdates)) {
    // deleteField はトップレベル（ドット記法パス含む）でのみ有効（本家と同じ制約）
    if (!isDeleteMarker(value) && containsDeleteMarker(value)) {
      throw new DocumentValidationError(
        `deleteField() can only appear at the top level of update data (field: ${key})`,
      );
    }
    // ドット記法キーはリーフのみ更新する（本家 updateDoc と同じ挙動。
    // 親マップ全体を置換すると兄弟フィールドが消えてしまう）
    setFieldByPath(mergedData, key, value);
  }

  return truncateTimestamps(mergedData) as DocumentData;
}
