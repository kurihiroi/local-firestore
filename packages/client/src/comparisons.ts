import type { DocumentData } from "@local-firestore/shared";
import type { Query } from "./query.js";
import type { QuerySnapshot } from "./snapshots.js";
import type { CollectionReference, DocumentReference, DocumentSnapshot } from "./types.js";

/** 2つの DocumentReference が同じドキュメントを指しているか比較する */
export function refEqual<T>(
  left: DocumentReference<T> | CollectionReference<T>,
  right: DocumentReference<T> | CollectionReference<T>,
): boolean {
  return left.type === right.type && left.path === right.path;
}

/** 2つの Query が同じクエリか比較する */
export function queryEqual<T = DocumentData>(left: Query<T>, right: Query<T>): boolean {
  return (
    left.collectionPath === right.collectionPath &&
    left.collectionGroup === right.collectionGroup &&
    JSON.stringify(left.constraints) === JSON.stringify(right.constraints)
  );
}

/** 2つのスナップショットが同じ内容か比較する */
export function snapshotEqual<T = DocumentData>(
  left: DocumentSnapshot<T> | QuerySnapshot<T>,
  right: DocumentSnapshot<T> | QuerySnapshot<T>,
): boolean {
  if ("ref" in left && "ref" in right && "exists" in left && "exists" in right) {
    // DocumentSnapshot の比較
    const leftDoc = left as DocumentSnapshot<T>;
    const rightDoc = right as DocumentSnapshot<T>;
    if (leftDoc.ref.path !== rightDoc.ref.path) return false;
    if (leftDoc.exists() !== rightDoc.exists()) return false;
    return JSON.stringify(leftDoc.data()) === JSON.stringify(rightDoc.data());
  }
  if ("docs" in left && "docs" in right) {
    // QuerySnapshot の比較
    const leftQuery = left as QuerySnapshot<T>;
    const rightQuery = right as QuerySnapshot<T>;
    if (leftQuery.size !== rightQuery.size) return false;
    for (let i = 0; i < leftQuery.docs.length; i++) {
      if (leftQuery.docs[i].path !== rightQuery.docs[i].path) return false;
      if (JSON.stringify(leftQuery.docs[i].data()) !== JSON.stringify(rightQuery.docs[i].data()))
        return false;
    }
    return true;
  }
  return false;
}
