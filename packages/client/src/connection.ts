import type { ServerMessage } from "@local-firestore/shared";
import type { Firestore } from "./types.js";

/** 接続状態 */
export type ConnectionState = "connected" | "disconnected" | "reconnecting";

/** 接続状態変更コールバック */
export type ConnectionStateListener = (state: ConnectionState) => void;

/** 再接続設定 */
export interface ReconnectOptions {
  /** 最大リトライ回数（0 = 無制限） */
  maxRetries: number;
  /** 初期遅延（ミリ秒） */
  initialDelay: number;
  /** 最大遅延（ミリ秒） */
  maxDelay: number;
  /** バックオフ倍率 */
  multiplier: number;
}

const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  maxRetries: 0,
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
};

/** サブスクリプション情報（再登録用） */
export interface SubscriptionInfo {
  id: string;
  message: string; // JSON文字列
}

/**
 * WebSocket接続を管理し、自動再接続・サブスクリプション再登録を行う
 */
export class ConnectionManager {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private options: ReconnectOptions;
  private wsUrl: string;

  /** アクティブなサブスクリプション（再接続時に再登録） */
  private subscriptions = new Map<string, string>();
  /** メッセージハンドラ */
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
  /** 接続状態リスナー */
  private stateListeners = new Set<ConnectionStateListener>();
  /** 接続完了待ちのPromise */
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;

  constructor(firestore: Firestore, options?: Partial<ReconnectOptions>) {
    this.wsUrl = firestore._transport.getWebSocketUrl();
    this.options = { ...DEFAULT_RECONNECT_OPTIONS, ...options };
  }

  /** 現在の接続状態 */
  getState(): ConnectionState {
    return this.state;
  }

  /** 接続状態変更リスナーを追加 */
  addStateListener(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** メッセージハンドラを設定 */
  setMessageHandler(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  /** WebSocket接続を確立する */
  connect(): WebSocket {
    if (this.ws && this.ws.readyState <= 1) {
      return this.ws;
    }

    this.ws = new WebSocket(this.wsUrl);
    this.connectPromise = new Promise<void>((resolve) => {
      this.connectResolve = resolve;
    });

    this.ws.onopen = () => {
      this.setState("connected");
      this.retryCount = 0;
      this.connectResolve?.();

      // 再接続時：既存のサブスクリプションを再登録
      for (const message of this.subscriptions.values()) {
        this.ws?.send(message);
      }
    };

    this.ws.onclose = () => {
      if (this.state === "connected" || this.state === "reconnecting") {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose が続けて呼ばれるのでここでは何もしない
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      this.messageHandler?.(msg);
    };

    return this.ws;
  }

  /** WebSocketが接続済みになるまで待つ */
  async waitForConnection(): Promise<void> {
    if (this.state === "connected") return;
    if (!this.connectPromise) {
      this.connect();
    }
    return this.connectPromise ?? Promise.resolve();
  }

  /** メッセージを送信する（接続中ならキューして接続後に送信） */
  send(data: string): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(data);
    } else {
      const ws = this.ws ?? this.connect();
      ws.addEventListener("open", () => ws.send(data), { once: true });
    }
  }

  /** サブスクリプションを登録する */
  registerSubscription(id: string, message: string): void {
    this.subscriptions.set(id, message);
    this.send(message);
  }

  /** サブスクリプションを解除する */
  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
    const unsubMsg = JSON.stringify({ type: "unsubscribe", subscriptionId: id });
    if (this.ws?.readyState === 1) {
      this.ws.send(unsubMsg);
    }
  }

  /** アクティブなサブスクリプション数 */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** 接続を切断する */
  disconnect(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setState("disconnected");
    if (this.ws) {
      // onclose による再接続を防ぐため、先に状態をリセット
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
  }

  /** 全リソースを解放する */
  dispose(): void {
    this.disconnect();
    this.subscriptions.clear();
    this.stateListeners.clear();
    this.messageHandler = null;
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of this.stateListeners) {
      listener(newState);
    }
  }

  private scheduleReconnect(): void {
    if (this.options.maxRetries > 0 && this.retryCount >= this.options.maxRetries) {
      return;
    }

    this.setState("reconnecting");
    const delay = Math.min(
      this.options.initialDelay * this.options.multiplier ** this.retryCount,
      this.options.maxDelay,
    );
    this.retryCount++;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}

/** Firestoreインスタンスごとの ConnectionManager */
const connectionManagers = new WeakMap<Firestore, ConnectionManager>();

/**
 * FirestoreインスタンスのConnectionManagerを取得または作成する
 */
export function getConnectionManager(
  firestore: Firestore,
  options?: Partial<ReconnectOptions>,
): ConnectionManager {
  let manager = connectionManagers.get(firestore);
  if (!manager) {
    manager = new ConnectionManager(firestore, options);
    connectionManagers.set(firestore, manager);
  }
  return manager;
}
