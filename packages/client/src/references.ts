import type { DocumentData, FirestoreDataConverter } from "@local-firestore/shared";
import { FirestoreError } from "./transport.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";

/**
 * ドキュメントリファレンスを取得する
 *
 * 使用例:
 *   doc(firestore, "users", "alice")
 *   doc(firestore, "users/alice")
 *   doc(collectionRef, "alice")
 */
export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T>,
  path: string,
  ...pathSegments: string[]
): DocumentReference<T> {
  const fullPath = [path, ...pathSegments].join("/");

  if (parent.type === "firestore") {
    const segments = fullPath.split("/");
    if (segments.length < 2 || segments.length % 2 !== 0) {
      throw new FirestoreError(
        "invalid-argument",
        `Invalid document path: "${fullPath}". Document paths must have an even number of segments.`,
      );
    }
    const docId = segments[segments.length - 1];
    const collPath = segments.slice(0, -1).join("/");

    const collRef = createCollectionReference<T>(parent, collPath);
    return createDocumentReference(parent, fullPath, docId, collRef);
  }

  // parent is CollectionReference
  const resolvedPath = `${parent.path}/${fullPath}`;
  const segments = resolvedPath.split("/");
  const docId = segments[segments.length - 1];
  return createDocumentReference(parent._firestore, resolvedPath, docId, parent);
}

/**
 * コレクションリファレンスを取得する
 *
 * 使用例:
 *   collection(firestore, "users")
 *   collection(docRef, "posts")
 */
export function collection<T = DocumentData>(
  parent: Firestore | DocumentReference,
  path: string,
  ...pathSegments: string[]
): CollectionReference<T> {
  const fullPath = [path, ...pathSegments].join("/");

  if (parent.type === "firestore") {
    const segments = fullPath.split("/");
    if (segments.length % 2 !== 1) {
      throw new FirestoreError(
        "invalid-argument",
        `Invalid collection path: "${fullPath}". Collection paths must have an odd number of segments.`,
      );
    }
    return createCollectionReference<T>(parent, fullPath);
  }

  // parent is DocumentReference
  const resolvedPath = `${parent.path}/${fullPath}`;
  return createCollectionReference<T>(parent._firestore, resolvedPath, parent);
}

/** @internal */
export function createDocumentReference<T>(
  firestore: Firestore,
  path: string,
  docId: string,
  parent: CollectionReference<T>,
  converter: FirestoreDataConverter<T> | null = null,
): DocumentReference<T> {
  return {
    type: "document",
    id: docId,
    path,
    parent,
    _firestore: firestore,
    _converter: converter,
    withConverter<U>(c: FirestoreDataConverter<U> | null) {
      if (c === null) {
        return createDocumentReference<DocumentData>(
          firestore,
          path,
          docId,
          createCollectionReference<DocumentData>(firestore, parent.path, parent.parent),
        );
      }
      return createDocumentReference<U>(
        firestore,
        path,
        docId,
        createCollectionReference<U>(firestore, parent.path, parent.parent, c),
        c,
      );
    },
  };
}

/** @internal */
export function createCollectionReference<T>(
  firestore: Firestore,
  path: string,
  parentDoc?: DocumentReference | null,
  converter: FirestoreDataConverter<T> | null = null,
): CollectionReference<T> {
  const segments = path.split("/");
  const collId = segments[segments.length - 1];
  return {
    type: "collection",
    id: collId,
    path,
    parent: parentDoc ?? null,
    _firestore: firestore,
    _converter: converter,
    withConverter<U>(c: FirestoreDataConverter<U> | null) {
      if (c === null) {
        return createCollectionReference<DocumentData>(firestore, path, parentDoc);
      }
      return createCollectionReference<U>(firestore, path, parentDoc, c);
    },
  };
}
