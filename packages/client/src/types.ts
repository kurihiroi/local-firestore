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
}

/** ドキュメントリファレンス */
export interface DocumentReference<T = DocumentData> {
  readonly type: "document";
  readonly id: string;
  readonly path: string;
  readonly parent: CollectionReference<T>;
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
  /** @internal */
  readonly _firestore: Firestore;
  /** @internal */
  readonly _converter: FirestoreDataConverter<T> | null;

  /** データコンバーターを設定した新しいリファレンスを返す */
  withConverter<U>(converter: FirestoreDataConverter<U>): CollectionReference<U>;
  withConverter(converter: null): CollectionReference<DocumentData>;
}

/** ドキュメントスナップショット */
export class DocumentSnapshot<T = DocumentData> {
  constructor(
    readonly ref: DocumentReference<T>,
    private readonly _data: T | null,
    private readonly _createTime: string | null,
    private readonly _updateTime: string | null,
  ) {}

  get id(): string {
    return this.ref.id;
  }

  exists(): boolean {
    return this._data !== null;
  }

  data(): T | undefined {
    return this._data ?? undefined;
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

  valueOf(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}
