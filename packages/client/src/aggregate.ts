import type {
  AggregateResponse,
  AggregateType,
  DocumentData,
  SerializedAggregateSpec,
} from "@local-firestore/shared";
import { type Query, query as toQuery } from "./query.js";
import type { CollectionReference } from "./types.js";

// ============================================================
// AggregateField
// ============================================================

/** 集計フィールド指定 */
// biome-ignore lint/correctness/noUnusedVariables: 将来のPhaseで型パラメータとして使用予定
export class AggregateField<T> {
  readonly type = "AggregateField" as const;

  constructor(
    readonly aggregateType: AggregateType,
    readonly fieldPath?: string,
  ) {}
}

/** count集計を作成する */
export function count(): AggregateField<number> {
  return new AggregateField<number>("count");
}

/** sum集計を作成する */
export function sum(fieldPath: string): AggregateField<number> {
  return new AggregateField<number>("sum", fieldPath);
}

/** average集計を作成する */
export function average(fieldPath: string): AggregateField<number | null> {
  return new AggregateField<number | null>("avg", fieldPath);
}

// ============================================================
// AggregateSpec 型
// ============================================================

/** 集計スペック: エイリアス名 → AggregateField */
export interface AggregateSpec {
  [field: string]: AggregateField<unknown>;
}

/** AggregateSpecからデータ型を導出 */
export type AggregateSpecData<T extends AggregateSpec> = {
  [K in keyof T]: T[K] extends AggregateField<infer U> ? U : never;
};

// ============================================================
// AggregateQuerySnapshot
// ============================================================

/** 集計クエリ結果のスナップショット */
export class AggregateQuerySnapshot<AggregateSpecType extends AggregateSpec, T = DocumentData> {
  readonly type = "AggregateQuerySnapshot" as const;

  constructor(
    readonly query: Query<T>,
    private readonly _data: Record<string, number | null>,
  ) {}

  /** 集計結果を取得する */
  data(): AggregateSpecData<AggregateSpecType> {
    return this._data as AggregateSpecData<AggregateSpecType>;
  }
}

// ============================================================
// getCountFromServer / getAggregateFromServer
// ============================================================

/** コレクション/クエリのドキュメント数を取得する */
export async function getCountFromServer<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
): Promise<AggregateQuerySnapshot<{ count: AggregateField<number> }, T>> {
  return getAggregateFromServer(queryOrRef, {
    count: count(),
  });
}

/** 集計クエリを実行する */
export async function getAggregateFromServer<
  AggregateSpecType extends AggregateSpec,
  T = DocumentData,
>(
  queryOrRef: Query<T> | CollectionReference<T>,
  aggregateSpec: AggregateSpecType,
): Promise<AggregateQuerySnapshot<AggregateSpecType, T>> {
  // CollectionReferenceをQueryに変換
  const q: Query<T> = queryOrRef.type === "collection" ? toQuery(queryOrRef) : queryOrRef;

  // AggregateSpecをシリアライズ
  const serializedSpec: SerializedAggregateSpec = {};
  for (const [alias, field] of Object.entries(aggregateSpec)) {
    serializedSpec[alias] = {
      aggregateType: field.aggregateType,
      fieldPath: field.fieldPath,
    };
  }

  const transport = q._firestore._transport;
  const res = await transport.post<AggregateResponse>("/aggregate", {
    collectionPath: q.collectionPath,
    collectionGroup: q.collectionGroup,
    constraints: q.constraints,
    aggregateSpec: serializedSpec,
  });

  return new AggregateQuerySnapshot<AggregateSpecType, T>(q, res.data);
}
