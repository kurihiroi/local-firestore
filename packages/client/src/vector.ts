/**
 * VectorValue - ベクトル埋め込み値の型
 *
 * AI/ML 連携での類似検索に使用するベクトルデータを表す。
 */
export class VectorValue {
  private readonly _values: ReadonlyArray<number>;

  private constructor(values: number[]) {
    this._values = Object.freeze([...values]);
  }

  /** 数値配列から VectorValue を作成する */
  static fromArray(values: number[]): VectorValue {
    return new VectorValue(values);
  }

  /** ベクトルの要素配列を返す */
  toArray(): number[] {
    return [...this._values];
  }

  /** ベクトルの次元数を返す */
  get dimensions(): number {
    return this._values.length;
  }

  /** 等値比較 */
  isEqual(other: VectorValue): boolean {
    if (this._values.length !== other._values.length) return false;
    return this._values.every((v, i) => v === other._values[i]);
  }
}

/** VectorValue を作成するヘルパー関数 */
export function vector(values: number[]): VectorValue {
  return VectorValue.fromArray(values);
}
