import type {
  SerializedOrderByConstraint,
  SerializedQueryConstraint,
  SerializedWhereConstraint,
} from "@local-firestore/shared";

/** インデックスフィールドの定義 */
export interface IndexField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
}

/** 複合インデックスの定義 */
export interface CompositeIndex {
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: IndexField[];
}

/** firestore.indexes.json のスキーマ */
export interface IndexConfiguration {
  indexes: CompositeIndex[];
  fieldOverrides?: unknown[];
}

/** インデックスバリデーションモード */
export type IndexValidationMode = "error" | "warn" | "off";

/** バリデーション結果 */
export interface IndexValidationResult {
  valid: boolean;
  missingIndex?: CompositeIndex;
  message?: string;
}

/**
 * 複合インデックスの定義を管理し、クエリ実行時にバリデーションを行う
 */
export class IndexManager {
  private indexes: CompositeIndex[] = [];
  private mode: IndexValidationMode;

  constructor(mode: IndexValidationMode = "warn") {
    this.mode = mode;
  }

  /** インデックス設定を読み込む */
  loadConfiguration(config: IndexConfiguration): void {
    this.indexes = config.indexes;
  }

  /** バリデーションモードを設定する */
  setMode(mode: IndexValidationMode): void {
    this.mode = mode;
  }

  /** 現在のモードを取得する */
  getMode(): IndexValidationMode {
    return this.mode;
  }

  /** 登録済みインデックス数 */
  get size(): number {
    return this.indexes.length;
  }

  /**
   * クエリに必要な複合インデックスが定義されているか検証する
   *
   * 以下のケースで複合インデックスが必要:
   * - 複数フィールドの where + orderBy
   * - 異なるフィールドの範囲フィルタの組み合わせ
   * - array-contains と他フィールドフィルタの組み合わせ
   */
  validateQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
  ): IndexValidationResult {
    if (this.mode === "off") {
      return { valid: true };
    }

    const wheres = constraints.filter((c): c is SerializedWhereConstraint => c.type === "where");
    const orderBys = constraints.filter(
      (c): c is SerializedOrderByConstraint => c.type === "orderBy",
    );

    // 単一フィールドのクエリはインデックス不要
    const uniqueFields = new Set<string>();
    for (const w of wheres) uniqueFields.add(w.fieldPath);
    for (const o of orderBys) uniqueFields.add(o.fieldPath);
    if (uniqueFields.size <= 1) {
      return { valid: true };
    }

    // 複合インデックスが必要なクエリかチェック
    const requiredIndex = this.buildRequiredIndex(collectionPath, wheres, orderBys);
    if (!requiredIndex) {
      return { valid: true };
    }

    // 定義済みインデックスの中にマッチするものがあるか
    const found = this.indexes.some((idx) => this.indexMatches(idx, requiredIndex));

    if (found) {
      return { valid: true };
    }

    const message = `Missing composite index for collection "${collectionPath}". Required fields: ${requiredIndex.fields.map((f) => `${f.fieldPath} (${f.order ?? f.arrayConfig ?? "ASCENDING"})`).join(", ")}`;

    if (this.mode === "warn") {
      console.warn(`[IndexManager] ${message}`);
      return { valid: true, missingIndex: requiredIndex, message };
    }

    // mode === "error"
    return { valid: false, missingIndex: requiredIndex, message };
  }

  private buildRequiredIndex(
    collectionPath: string,
    wheres: SerializedWhereConstraint[],
    orderBys: SerializedOrderByConstraint[],
  ): CompositeIndex | null {
    const fields: IndexField[] = [];

    // equality フィルタのフィールドを先に
    for (const w of wheres) {
      if (w.op === "==" || w.op === "in") {
        fields.push({ fieldPath: w.fieldPath, order: "ASCENDING" });
      } else if (w.op === "array-contains" || w.op === "array-contains-any") {
        fields.push({ fieldPath: w.fieldPath, arrayConfig: "CONTAINS" });
      }
    }

    // 範囲フィルタのフィールド
    for (const w of wheres) {
      if (
        w.op !== "==" &&
        w.op !== "in" &&
        w.op !== "array-contains" &&
        w.op !== "array-contains-any"
      ) {
        if (!fields.some((f) => f.fieldPath === w.fieldPath)) {
          fields.push({ fieldPath: w.fieldPath, order: "ASCENDING" });
        }
      }
    }

    // orderBy のフィールド
    for (const o of orderBys) {
      if (!fields.some((f) => f.fieldPath === o.fieldPath)) {
        fields.push({
          fieldPath: o.fieldPath,
          order: o.direction === "desc" ? "DESCENDING" : "ASCENDING",
        });
      }
    }

    if (fields.length <= 1) return null;

    // コレクションパスからコレクション名を抽出
    const segments = collectionPath.split("/");
    const collectionGroup = segments[segments.length - 1];

    return {
      collectionGroup,
      queryScope: "COLLECTION",
      fields,
    };
  }

  private indexMatches(defined: CompositeIndex, required: CompositeIndex): boolean {
    if (defined.collectionGroup !== required.collectionGroup) return false;
    if (defined.fields.length < required.fields.length) return false;

    // 定義されたインデックスが必要なフィールドをすべて含んでいるか
    return required.fields.every((req) =>
      defined.fields.some(
        (def) =>
          def.fieldPath === req.fieldPath &&
          (def.order === req.order || def.arrayConfig === req.arrayConfig),
      ),
    );
  }
}
