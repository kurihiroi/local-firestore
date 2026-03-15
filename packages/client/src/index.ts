// Firestore initialization

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
// Types
export type { CollectionReference, DocumentReference, Firestore } from "./types.js";
export { DocumentSnapshot, Timestamp } from "./types.js";
