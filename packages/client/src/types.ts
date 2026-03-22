import type {
  DocumentData,
  FirestoreDataConverter,
  SerializedTimestamp,
} from "@local-firestore/shared";
import type { HttpTransport } from "./transport.js";

/** Firestoreインスタンス */
export interface Firestore {
  readonly type: "firestore";
  /** @internal */
  readonly _transport: HttpTransport;
  /** @internal データベースID（マルチデータベース対応） */
  readonly _databaseId?: string;
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
  constructor(
    readonly ref: DocumentReference<T>,
    private readonly _data: T | null,
    private readonly _createTime: string | null,
    private readonly _updateTime: string | null,
  ) {}

  /** スナップショットのメタデータ */
  readonly metadata: SnapshotMetadata = DEFAULT_METADATA;

  get id(): string {
    return this.ref.id;
  }

  exists(): boolean {
    return this._data !== null;
  }

  data(_options?: SnapshotOptions): T | undefined {
    return this._data ?? undefined;
  }

  /** フィールドパスで指定したフィールドの値を取得する */
  get(fieldPath: string | FieldPath): unknown {
    if (!this._data) return undefined;
    const fp = typeof fieldPath === "string" ? new FieldPath(...fieldPath.split(".")) : fieldPath;
    return fp.resolveValue(this._data as Record<string, unknown>);
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

  /** @internal ISO文字列からTimestampを生成 */
  static fromISO(iso: string): Timestamp {
    return Timestamp.fromDate(new Date(iso));
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

  /** ドット区切りのパス文字列を返す */
  toString(): string {
    return this.segments.join(".");
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
