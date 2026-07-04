import type { Firestore } from "./types.js";
import { WriteQueue } from "./write-queue.js";

interface NetworkState {
  enabled: boolean;
  queue: WriteQueue;
}

/** Firestore インスタンスごとのネットワーク状態 */
const networkStates = new WeakMap<Firestore, NetworkState>();

function getState(firestore: Firestore): NetworkState {
  let state = networkStates.get(firestore);
  if (!state) {
    state = { enabled: true, queue: new WriteQueue(firestore._transport) };
    networkStates.set(firestore, state);
  }
  return state;
}

/** @internal ネットワークが有効かどうか */
export function isNetworkEnabled(firestore: Firestore): boolean {
  return getState(firestore).enabled;
}

/** @internal ネットワークの有効/無効を切り替える */
export function setNetworkEnabled(firestore: Firestore, enabled: boolean): void {
  getState(firestore).enabled = enabled;
}

/** @internal オフライン書き込みキューを取得する */
export function getWriteQueue(firestore: Firestore): WriteQueue {
  return getState(firestore).queue;
}
