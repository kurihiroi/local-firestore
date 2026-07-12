import type {
  DocumentData,
  FirestoreDataConverter,
  SerializedTimestamp,
} from "@local-firestore/shared";
import { formatFieldPath } from "@local-firestore/shared";
import type { HttpTransport } from "./transport.js";

/** Firestoreインスタンス */
export interface Firestore {
  readonly type: "firestore";
  /** @internal `connectFirestoreEmulator()` で差し替えられるため mutable */
  _transport: HttpTransport;
  /** @internal データベースID（マルチデータベース対応） */
  readonly _databaseId?: string;
  /** @internal undefined 値のフィールドを黙って除外するか（FirestoreSettings 由来） */
  readonly _ignoreUndefinedProperties?: boolean;
}

/** ドキュメントリファレンス */
export interface DocumentReference<T = DocumentData> {
  readonly type: "document";
  readonly id: string;
  readonly path: string;
  readonly parent: CollectionReference<T>;
  /** Firestore インスタンス */
  readonly firestore: Firestore;
  /** データコンバーター */
  readonly converter: FirestoreDataConverter<T> | null;
  /** @internal */
  readonly _firestore: Firestore;
  /** @internal */
  readonly _converter: FirestoreDataConverter<T> | null;

  /** データコンバーターを設定した新しいリファレンスを返す */
  withConverter<U>(converter: FirestoreDataConverter<U>): DocumentReference<U>;
  withConverter(converter: null): DocumentReference<DocumentData>;
}

/** コレクションリファレンス */
export interface CollectionReference<T = DocumentData> {
  readonly type: "collection";
  readonly id: string;
  readonly path: string;
  readonly parent: DocumentReference | null;
  /** Firestore インスタンス */
  readonly firestore: Firestore;
  /** データコンバーター */
  readonly converter: FirestoreDataConverter<T> | null;
  /** @internal */
  readonly _firestore: Firestore;
  /** @internal */
  readonly _converter: FirestoreDataConverter<T> | null;

  /** データコンバーターを設定した新しいリファレンスを返す */
  withConverter<U>(converter: FirestoreDataConverter<U>): CollectionReference<U>;
  withConverter(converter: null): CollectionReference<DocumentData>;
}

/** スナップショットデータ取得オプション */
export interface SnapshotOptions {
  readonly serverTimestamps?: "estimate" | "previous" | "none";
}

/** 保留中 serverTimestamp の解決方法 */
export type ServerTimestampBehavior = NonNullable<SnapshotOptions["serverTimestamps"]>;

/**
 * @internal 保留中 serverTimestamp のワイヤ形式マーカー
 *
 * LocalStore がレイテンシ補償のローカルビュー合成時に serverTimestamp
 * センチネルをこの形式に解決し、スナップショットの data(options) で
 * SnapshotOptions.serverTimestamps に応じた値へ最終解決する。
 * サーバーへ送信されることはない（送信データは元のセンチネルのまま）。
 */
export interface PendingServerTimestampWire {
  __type: "pendingServerTimestamp";
  /** ローカル書き込み時刻による推定値 */
  estimate: SerializedTimestamp;
  /** 直前の確定値（ワイヤ形式。存在しない場合は null） */
  previous: unknown;
}

/** @internal 値が保留中 serverTimestamp マーカー（ワイヤ形式）かどうか */
export function isPendingServerTimestampWire(value: unknown): value is PendingServerTimestampWire {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__type === "pendingServerTimestamp"
  );
}

/**
 * @internal デシリアライズ後の保留中 serverTimestamp プレースホルダ
 *
 * DocumentSnapshot / QueryDocumentSnapshot の data(options) が
 * serverTimestamps オプション（デフォルト 'none' = null）に従って解決する。
 */
export class PendingServerTimestamp {
  constructor(
    /** ローカル書き込み時刻による推定値 */
    readonly estimate: Timestamp,
    /** 直前の確定値（デシリアライズ済み。存在しない場合は null） */
    readonly previous: unknown,
  ) {}
}

/**
 * @internal 保留中 serverTimestamp を SnapshotOptions に従って解決する
 *
 * 本家挙動: 'none'（デフォルト）は null、'estimate' はローカル推定値、
 * 'previous' は直前の確定値（なければ null）。
 */
export function resolvePendingTimestamps(
  value: unknown,
  behavior: ServerTimestampBehavior,
): unknown {
  if (value instanceof PendingServerTimestamp) {
    switch (behavior) {
      case "estimate":
        return value.estimate;
      case "previous":
        return value.previous ?? null;
      default:
        return null;
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolvePendingTimestamps(v, behavior));
  }
  // プレーンオブジェクト（マップ）のみ再帰する。Timestamp / GeoPoint 等の
  // クラスインスタンスはそのまま返す
  if (typeof value === "object" && value !== null && value.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolvePendingTimestamps(v, behavior);
    }
    return result;
  }
  return value;
}

/** スナップショットのメタデータ */
export class SnapshotMetadata {
  constructor(
    readonly hasPendingWrites: boolean,
    readonly fromCache: boolean,
  ) {}

  isEqual(other: SnapshotMetadata): boolean {
    return this.hasPendingWrites === other.hasPendingWrites && this.fromCache === other.fromCache;
  }
}

/** ローカルエミュレータ用のデフォルトメタデータ */
const DEFAULT_METADATA = new SnapshotMetadata(false, false);

/** ドキュメントスナップショット */
export class DocumentSnapshot<T = DocumentData> {
  /** スナップショットのメタデータ */
  readonly metadata: SnapshotMetadata;

  constructor(
    readonly ref: DocumentReference<T>,
    private readonly _data: T | null,
    private readonly _createTime: string | null,
    private readonly _updateTime: string | null,
    metadata?: SnapshotMetadata,
  ) {
    this.metadata = metadata ?? DEFAULT_METADATA;
  }

  get id(): string {
    return this.ref.id;
  }

  exists(): boolean {
    return this._data !== null;
  }

  data(options?: SnapshotOptions): T | undefined {
    if (this._data === null) return undefined;
    // 保留中 serverTimestamp はローカル書き込み中にしか存在しないため、
    // それ以外は走査コストを省く
    if (!this.metadata.hasPendingWrites) return this._data;
    return resolvePendingTimestamps(this._data, options?.serverTimestamps ?? "none") as T;
  }

  /** フィールドパスで指定したフィールドの値を取得する */
  get(fieldPath: string | FieldPath, options?: SnapshotOptions): unknown {
    if (!this._data) return undefined;
    const fp = typeof fieldPath === "string" ? new FieldPath(...fieldPath.split(".")) : fieldPath;
    const value = fp.resolveValue(this._data as Record<string, unknown>);
    if (!this.metadata.hasPendingWrites) return value;
    return resolvePendingTimestamps(value, options?.serverTimestamps ?? "none");
  }

  get createTime(): Timestamp | undefined {
    return this._createTime ? Timestamp.fromISO(this._createTime) : undefined;
  }

  get updateTime(): Timestamp | undefined {
    return this._updateTime ? Timestamp.fromISO(this._updateTime) : undefined;
  }
}

/** Timestamp型 */
export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}

  static now(): Timestamp {
    const ms = Date.now();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }

  static fromDate(date: Date): Timestamp {
    const ms = date.getTime();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }

  static fromMillis(milliseconds: number): Timestamp {
    return new Timestamp(Math.floor(milliseconds / 1000), (milliseconds % 1000) * 1_000_000);
  }

  /**
   * @internal ISO文字列からTimestampを生成
   *
   * ミリ秒を超える小数秒（マイクロ秒 / ナノ秒精度）も丸めずにパースする。
   * サーバーの createTime / updateTime はマイクロ秒精度で生成されるため、
   * `new Date(iso)`（ミリ秒精度に丸められる）では精度が落ちる。
   */
  static fromISO(iso: string): Timestamp {
    const match = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
    if (!match) {
      return Timestamp.fromDate(new Date(iso));
    }
    const [, base, fraction, offset] = match;
    const epochMs = new Date(`${base}${offset}`).getTime();
    if (Number.isNaN(epochMs)) {
      return Timestamp.fromDate(new Date(iso));
    }
    const nanoseconds = fraction ? Number(fraction.padEnd(9, "0")) : 0;
    return new Timestamp(epochMs / 1000, nanoseconds);
  }

  /** @internal シリアライズされた形式から復元 */
  static fromSerialized(value: SerializedTimestamp["value"]): Timestamp {
    return new Timestamp(value.seconds, value.nanoseconds);
  }

  toDate(): Date {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1_000_000);
  }

  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }

  isEqual(other: Timestamp): boolean {
    return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
  }

  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }

  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }

  valueOf(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}

/**
 * FieldPath - フィールドパスを表すクラス
 *
 * ネストされたフィールドへのアクセスに使用する。
 * Firebase互換の `FieldPath` と同じインターフェース。
 */
export class FieldPath {
  private readonly segments: string[];

  constructor(...fieldNames: string[]) {
    if (fieldNames.length === 0) {
      throw new Error("FieldPath must have at least one field name");
    }
    for (const name of fieldNames) {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("FieldPath field names must be non-empty strings");
      }
    }
    this.segments = fieldNames;
  }

  /** ドキュメントIDを指す特殊な FieldPath */
  static documentId(): FieldPath {
    return new FieldPath("__name__");
  }

  /**
   * ドット区切りのパス文字列を返す。
   * 単純形式（[_a-zA-Z][_a-zA-Z0-9]*）でないフィールド名は本家同様
   * バッククォートでエスケープされる（例: `with-dash`、ドットを含む `a.b`）。
   */
  toString(): string {
    return formatFieldPath(this.segments);
  }

  /** 他の FieldPath と等しいか比較する */
  isEqual(other: FieldPath): boolean {
    if (this.segments.length !== other.segments.length) return false;
    return this.segments.every((s, i) => s === other.segments[i]);
  }

  /** @internal セグメント配列を取得 */
  getSegments(): ReadonlyArray<string> {
    return this.segments;
  }

  /** @internal ネストされたオブジェクトから値を取得する */
  resolveValue(data: Record<string, unknown>): unknown {
    let current: unknown = data;
    for (const segment of this.segments) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}
