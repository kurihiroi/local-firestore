import type { FieldValueSentinel } from "@local-firestore/shared";

/** サーバータイムスタンプに置換されるセンチネル値を返す */
export function serverTimestamp(): FieldValueSentinel {
  return { __fieldValue: true, type: "serverTimestamp" };
}

/** フィールドを削除するセンチネル値を返す */
export function deleteField(): FieldValueSentinel {
  return { __fieldValue: true, type: "deleteField" };
}

/** フィールドの値を増減させるセンチネル値を返す */
export function increment(n: number): FieldValueSentinel {
  return { __fieldValue: true, type: "increment", value: n };
}

/** 配列にユニークな要素を追加するセンチネル値を返す */
export function arrayUnion(...elements: unknown[]): FieldValueSentinel {
  return { __fieldValue: true, type: "arrayUnion", value: elements };
}

/** 配列から指定した要素を除去するセンチネル値を返す */
export function arrayRemove(...elements: unknown[]): FieldValueSentinel {
  return { __fieldValue: true, type: "arrayRemove", value: elements };
}
