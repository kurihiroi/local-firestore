import type { DocumentData } from "@local-firestore/shared";
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
  constructor(readonly docs: QueryDocumentSnapshot<T>[]) {}

  get size(): number {
    return this.docs.length;
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }

  forEach(callback: (doc: QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(callback);
  }
}
