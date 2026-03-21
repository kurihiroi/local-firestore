export type {
  DocumentData,
  FirestoreDataConverter,
  FirestoreErrorCode,
  PartialWithFieldValue,
  SetOptions,
  WithFieldValue,
} from "@local-firestore/shared";
// Aggregate
export type { AggregateSpec, AggregateSpecData } from "./aggregate.js";
export {
  AggregateField,
  AggregateQuerySnapshot,
  average,
  count,
  getAggregateFromServer,
  getCountFromServer,
  sum,
} from "./aggregate.js";
// Batch & Transaction
export { WriteBatch, writeBatch } from "./batch.js";
// Data types
export { Bytes } from "./bytes.js";
// CRUD operations
export { addDoc, deleteDoc, getDoc, setDoc, updateDoc } from "./crud.js";
// FieldValue helpers
export {
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from "./field-values.js";
export type { FirestoreSettings } from "./firestore.js";
export { getFirestore } from "./firestore.js";
export { GeoPoint } from "./geo-point.js";
// Real-time listeners
export type { DocumentChange, DocumentChangeType, Unsubscribe } from "./listener.js";
export { onSnapshot } from "./listener.js";
export type { Query, QueryConstraint } from "./query.js";
// Query operations
export {
  and,
  collectionGroup,
  endAt,
  endBefore,
  getDocs,
  limit,
  limitToLast,
  or,
  orderBy,
  query,
  startAfter,
  startAt,
  where,
} from "./query.js";
// References
export { collection, doc } from "./references.js";
export { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
export type { TransactionOptions } from "./transaction.js";
export { runTransaction, Transaction } from "./transaction.js";
// Transport & Errors
export { FirestoreError } from "./transport.js";
// Types
export type { CollectionReference, DocumentReference, Firestore } from "./types.js";
export { DocumentSnapshot, Timestamp } from "./types.js";
