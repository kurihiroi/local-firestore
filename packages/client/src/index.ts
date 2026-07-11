export type {
  DocumentData,
  FirestoreDataConverter,
  FirestoreErrorCode,
  PartialWithFieldValue,
  SetOptions,
  UpdateData,
  VectorDistanceMeasure,
  WithFieldValue,
} from "@local-firestore/shared";
// Aggregate
export type { AggregateSpec, AggregateSpecData } from "./aggregate.js";
export {
  AggregateField,
  AggregateQuerySnapshot,
  aggregateFieldEqual,
  aggregateQuerySnapshotEqual,
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
// Equality comparisons
export { queryEqual, refEqual, snapshotEqual } from "./comparisons.js";
// Connection management
export type { ConnectionState, ReconnectOptions } from "./connection.js";
export { ConnectionManager, getConnectionManager } from "./connection.js";
// CRUD operations
export {
  addDoc,
  deleteDoc,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  setDoc,
  updateDoc,
} from "./crud.js";
// FieldValue helpers
export {
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from "./field-values.js";
export type {
  ConnectFirestoreEmulatorOptions,
  EmulatorMockTokenOptions,
  FirestoreSettings,
  LogLevel,
} from "./firestore.js";
export {
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
  getFirestore,
  initializeFirestore,
  setLogLevel,
  terminate,
  waitForPendingWrites,
} from "./firestore.js";
export { GeoPoint } from "./geo-point.js";
// Real-time listeners
export type {
  DocumentChange,
  DocumentChangeType,
  ListenSource,
  SnapshotListenOptions,
  SnapshotObserver,
  Unsubscribe,
} from "./listener.js";
export { onSnapshot, onSnapshotsInSync } from "./listener.js";
export type {
  FindNearestOptions,
  Query,
  QueryConstraint,
  QueryConstraintType,
  QueryFilterConstraint,
  QueryNonFilterConstraint,
} from "./query.js";
// Query operations
export {
  and,
  collectionGroup,
  documentId,
  endAt,
  endBefore,
  findNearest,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
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
// Snapshot cache
export type { CachedDocument, CachedQuery } from "./snapshot-cache.js";
export { SnapshotCache } from "./snapshot-cache.js";
export { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
export type { TransactionOptions } from "./transaction.js";
export { runTransaction, Transaction } from "./transaction.js";
// Transport & Errors
export { FirestoreError } from "./transport.js";
// Types
export type {
  CollectionReference,
  DocumentReference,
  Firestore,
  SnapshotOptions,
} from "./types.js";
export { DocumentSnapshot, FieldPath, SnapshotMetadata, Timestamp } from "./types.js";
// Vector
export { VectorValue, vector } from "./vector.js";
// Write queue (offline support)
