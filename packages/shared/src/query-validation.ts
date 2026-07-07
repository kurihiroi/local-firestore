import type { SerializedQueryConstraint, SerializedWhereConstraint } from "./types.js";

/**
 * クエリフィルタの本家パリティバリデーション
 *
 * 本家 Firestore がエラーにする組合せ・要素数制限を検証する。
 * クライアント（早期エラー）とサーバー（防御的検証）の両方から使用される。
 */

/** `in` / `array-contains-any` フィルタの最大要素数 */
export const MAX_DISJUNCTION_VALUES = 30;

/** `not-in` フィルタの最大要素数（本家は 10） */
export const MAX_NOT_IN_VALUES = 10;

/** 制約リストから where フィルタを抽出する（and / or 複合フィルタの内部を含む） */
function collectWhereFilters(
  constraints: ReadonlyArray<SerializedQueryConstraint>,
): SerializedWhereConstraint[] {
  const filters: SerializedWhereConstraint[] = [];
  for (const c of constraints) {
    if (c.type === "where") {
      filters.push(c);
    } else if (c.type === "and" || c.type === "or") {
      filters.push(...c.filters);
    }
  }
  return filters;
}

/**
 * クエリフィルタを検証し、本家がエラーにする入力に対してエラーメッセージを返す。
 * 有効な場合は null を返す。
 *
 * - `in` / `array-contains-any`: 非空配列・最大30要素
 * - `not-in`: 非空配列・最大10要素
 * - `array-contains` の複数指定
 * - `not-in` の複数指定
 * - `not-in` と `!=` の併用
 * - `not-in` と `in` / `array-contains-any` の併用
 */
export function validateQueryFilters(
  constraints: ReadonlyArray<SerializedQueryConstraint>,
): string | null {
  const filters = collectWhereFilters(constraints);

  let arrayContainsCount = 0;
  let notInCount = 0;
  let hasNotEqual = false;
  let hasIn = false;
  let hasArrayContainsAny = false;

  for (const f of filters) {
    switch (f.op) {
      case "in":
      case "array-contains-any": {
        if (!Array.isArray(f.value) || f.value.length === 0) {
          return `Invalid Query. A non-empty array is required for '${f.op}' filters.`;
        }
        if (f.value.length > MAX_DISJUNCTION_VALUES) {
          return `Invalid Query. '${f.op}' filters support a maximum of ${MAX_DISJUNCTION_VALUES} elements in the value array.`;
        }
        if (f.op === "in") hasIn = true;
        else hasArrayContainsAny = true;
        break;
      }
      case "not-in": {
        if (!Array.isArray(f.value) || f.value.length === 0) {
          return `Invalid Query. A non-empty array is required for 'not-in' filters.`;
        }
        if (f.value.length > MAX_NOT_IN_VALUES) {
          return `Invalid Query. 'not-in' filters support a maximum of ${MAX_NOT_IN_VALUES} elements in the value array.`;
        }
        notInCount++;
        break;
      }
      case "array-contains":
        arrayContainsCount++;
        break;
      case "!=":
        hasNotEqual = true;
        break;
      default:
        break;
    }
  }

  if (arrayContainsCount > 1) {
    return "Invalid Query. You cannot use more than one 'array-contains' filter.";
  }
  if (notInCount > 1) {
    return "Invalid Query. You cannot use more than one 'not-in' filter.";
  }
  if (notInCount > 0 && hasNotEqual) {
    return "Invalid Query. You cannot use 'not-in' filters with '!=' filters.";
  }
  if (notInCount > 0 && hasIn) {
    return "Invalid Query. You cannot use 'not-in' filters with 'in' filters.";
  }
  if (notInCount > 0 && hasArrayContainsAny) {
    return "Invalid Query. You cannot use 'not-in' filters with 'array-contains-any' filters.";
  }

  return null;
}
