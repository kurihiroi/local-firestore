// Firestore initialization
export { getFirestore } from "./firestore.js";
export type { FirestoreSettings } from "./firestore.js";

// References
export { doc, collection } from "./references.js";

// CRUD operations
export { getDoc, setDoc, addDoc, updateDoc, deleteDoc } from "./crud.js";

// FieldValue helpers
export { serverTimestamp, deleteField, increment, arrayUnion, arrayRemove } from "./field-values.js";

// Types
export type { Firestore, DocumentReference, CollectionReference } from "./types.js";
export { DocumentSnapshot, Timestamp } from "./types.js";
