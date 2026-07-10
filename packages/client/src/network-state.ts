import type { Firestore } from "./types.js";

interface NetworkState {
  enabled: boolean;
}

/** Firestore インスタンスごとのネットワーク状態 */
const networkStates = new WeakMap<Firestore, NetworkState>();

function getState(firestore: Firestore): NetworkState {
  let state = networkStates.get(firestore);
  if (!state) {
    state = { enabled: true };
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
