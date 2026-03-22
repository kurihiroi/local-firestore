import type { DocumentData } from "@local-firestore/shared";
import type { DocumentChange } from "./listener.js";
import type { Query } from "./query.js";
import { createCollectionReference, createDocumentReference } from "./references.js";
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  SnapshotOptions,
} from "./types.js";
import { FieldPath, SnapshotMetadata, Timestamp } from "./types.js";

/** クエリ結果のドキュメントスナップショット（必ず存在する） */
export class QueryDocumentSnapshot<T = DocumentData> {
  /** ドキュメントリファレンス */
  readonly ref: DocumentReference<T>;

  constructor(
    readonly path: string,
    readonly id: string,
    private readonly _data: T,
    private readonly _createTime: string,
    private readonly _updateTime: string,
    firestore?: Firestore,
  ) {
    if (firestore) {
      const segments = path.split("/");
      const collPath = segments.slice(0, -1).join("/");
      const collRef = createCollectionReference<T>(firestore, collPath);
      this.ref = createDocumentReference<T>(firestore, path, id, collRef);
    } else {
      // 後方互換: firestore 未指定時はダミーの ref を生成
      this.ref = { type: "document", id, path } as DocumentReference<T>;
    }
  }

  /** スナップショットのメタデータ */
  readonly metadata: SnapshotMetadata = new SnapshotMetadata(false, false);

  exists(): boolean {
    return true;
  }

  data(_options?: SnapshotOptions): T {
    return this._data;
  }

  /** フィールドパスで指定したフィールドの値を取得する */
  get(fieldPath: string | FieldPath): unknown {
    const fp = typeof fieldPath === "string" ? new FieldPath(...fieldPath.split(".")) : fieldPath;
    return fp.resolveValue(this._data as Record<string, unknown>);
  }

  get createTime(): Timestamp {
    return Timestamp.fromISO(this._createTime);
  }

  get updateTime(): Timestamp {
    return Timestamp.fromISO(this._updateTime);
  }
}

/** クエリ結果のスナップショット */
export class QuerySnapshot<T = DocumentData> {
  private readonly _changes: DocumentChange<T>[];

  /** 元のクエリ */
  readonly query: Query<T> | CollectionReference<T>;

  /** スナップショットのメタデータ */
  readonly metadata: SnapshotMetadata = new SnapshotMetadata(false, false);

  constructor(
    readonly docs: QueryDocumentSnapshot<T>[],
    changes?: DocumentChange<T>[],
    query?: Query<T> | CollectionReference<T>,
  ) {
    this._changes = changes ?? [];
    this.query = query as Query<T> | CollectionReference<T>;
  }

  get size(): number {
    return this.docs.length;
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }

  forEach(callback: (doc: QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(callback);
  }

  /** ドキュメントの変更一覧を返す */
  docChanges(): DocumentChange<T>[] {
    return this._changes;
  }
}
