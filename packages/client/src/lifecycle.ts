import { FirestoreError } from "./transport.js";
import type { Firestore } from "./types.js";

/**
 * terminate() 済みのインスタンスに対する操作を拒否する（本家互換）。
 * 各 API のエントリポイントから呼び出す。
 */
export function assertNotTerminated(firestore: Firestore): void {
  if (firestore._terminated) {
    throw new FirestoreError("failed-precondition", "The client has already been terminated.");
  }
}
