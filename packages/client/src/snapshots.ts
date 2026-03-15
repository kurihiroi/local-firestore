import type { DocumentData } from "@local-firestore/shared";
import type { DocumentChange } from "./listener.js";
import { Timestamp } from "./types.js";

/** クエリ結果のドキュメントスナップショット（必ず存在する） */
export class QueryDocumentSnapshot<T = DocumentData> {
  constructor(
    readonly path: string,
    readonly id: string,
    private readonly _data: T,
    private readonly _createTime: string,
    private readonly _updateTime: string,
  ) {}

  exists(): boolean {
    return true;
  }

  data(): T {
    return this._data;
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

  constructor(
    readonly docs: QueryDocumentSnapshot<T>[],
    changes?: DocumentChange<T>[],
  ) {
    this._changes = changes ?? [];
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
